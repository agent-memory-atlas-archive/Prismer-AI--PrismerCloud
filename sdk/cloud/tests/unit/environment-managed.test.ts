import ts from 'typescript';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentsClient, PrismerClient } from '../../src/index';

const lifecycle = {
  mode: 'managed', leaseExpiresAt: null, retentionExpiresAt: '2026-10-23T00:00:00Z',
  recoverable: true, latestSnapshotId: 'snap/a +',
  lastFailure: { code: 'provider_unavailable', message: 'capture failed', at: '2026-10-22T00:00:00Z', operationId: 'op_1', attempt: 2, terminal: false },
};
const status = {
  environmentId: 'env/a +', state: 'stopped', revision: 4, epoch: 2,
  readiness: { sandbox: false, services: false, agent: null }, startupPath: null,
  templateVersion: 'v1', expiresAt: '2026-10-22T00:00:00Z', milestones: [],
};
function setup(data: unknown, write = { success: true, data: { environmentId: status.environmentId, state: 'provisioning', epoch: 3, revision: 5, operationId: 'op_2' }, requestId: 'write' }) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === 'GET' ? { success: true, data, requestId: 'read' } : write,
  ), { status: init?.method === 'GET' ? 200 : 202 }));
  return { client: new PrismerClient({ apiKey: 'sk-eaas-synthetic', baseUrl: 'https://eaas.invalid', fetch }), fetch, write };
}

it('exports exact managed lifecycle and optional pool constraints through both public TS entrypoints', () => {
  const file = resolve('src/__managed_typecheck__.ts');
  const exampleFile = resolve('src/__managed_docs_typecheck__.ts');
  const example = readFileSync('README.md', 'utf8').split('### Resume a managed environment')[1]
    .match(/```typescript\n([\s\S]*?)```/)![1].replace("from '@prismer/sdk'", "from './index'");
  const source = `
    import type { EnvironmentStatus, EnvironmentLifecycleStatus, EnvironmentLifecycleFailure, ProjectPoolConstraints, ProjectPoolConstraint, PoolPolicyStatus, PrismerClient, EaasApiEnvelope, EaasLifecycleResult } from './index';
    import type { EnvironmentLifecycleStatus as SubpathLifecycle, ProjectPoolConstraints as SubpathConstraints } from './environment-contract';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    type ExpectedFailure = {code: string; message: string; at: string; operationId?: string; attempt?: number; terminal?: boolean};
    type ExpectedLifecycle = {mode: 'managed'; leaseExpiresAt: string | null; retentionExpiresAt: string | null; recoverable: boolean; latestSnapshotId: string | null; lastFailure: ExpectedFailure | null};
    type A = Assert<Equal<EnvironmentLifecycleStatus, ExpectedLifecycle>>;
    type B = Assert<Equal<EnvironmentLifecycleFailure, ExpectedFailure>>;
    type C = Assert<Equal<EnvironmentStatus['lifecycle'], ExpectedLifecycle | undefined>>;
    type D = Assert<Equal<SubpathLifecycle, EnvironmentLifecycleStatus>>;
    type E = Assert<Equal<SubpathConstraints, ProjectPoolConstraints>>;
    type F = Assert<Equal<ProjectPoolConstraint, {poolId: string; mode: 'cold' | 'warm' | 'provider-managed'; maxReady: number; canEnable: boolean; allowedOnMiss: Array<'cold' | 'reject'>; fallbackPoolIds: string[]}>>;
    type G = Assert<Equal<ProjectPoolConstraints, {maxReady: number; pools: ProjectPoolConstraint[]}>>;
    type H = Assert<Equal<PoolPolicyStatus['constraints'], ProjectPoolConstraints | undefined>>;
    declare const client: PrismerClient;
    const resumed: Promise<EaasApiEnvelope<EaasLifecycleResult>> = client.environments.resume('env', {idempotencyKey: 'stable'});
    declare const legacy: Omit<EnvironmentStatus, 'lifecycle'>;
    const compatible: EnvironmentStatus = legacy;
  `;
  const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, version, onError, fresh) => path === file ? ts.createSourceFile(path, source, version, true) : path === exampleFile ? ts.createSourceFile(path, example, version, true) : original(path, version, onError, fresh);
  const program = ts.createProgram([file, exampleFile], options, host);
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
});

it.each([undefined, lifecycle, { ...lifecycle, lastFailure: null }])('keeps managed detail or legacy omission on GET/list: %j', async managed => {
  const data = { ...status, ...(managed === undefined ? {} : { lifecycle: managed }) };
  const {client} = setup(data);
  expect(await client.environments.get(status.environmentId)).toEqual({ success: true, data, requestId: 'read' });
  const list = setup({ environments: [data], nextCursor: null });
  expect(await list.client.environments.list()).toEqual({ success: true, data: { environments: [data], nextCursor: null }, requestId: 'read' });
});

it.each([undefined, { maxReady: 1, pools: [{ poolId: 'warm', mode: 'warm', maxReady: 1, canEnable: true, allowedOnMiss: ['cold', 'reject'], fallbackPoolIds: ['cold'] }] }])('keeps same-revision constraints or old omission through poolPolicy.get: %j', async constraints => {
  const data = { revision: 4, observedRevision: 3, configRevision: 'cfg', allowedPoolIds: ['warm', 'cold'], policy: { maxReady: 1, dailyBudgetCredits: '1', defaultPoolId: 'warm', fallbackPoolIds: [], pools: [] }, ...(constraints === undefined ? {} : { constraints }) };
  const { client } = setup(data);
  expect(await client.projects.poolPolicy.get('project')).toEqual({ success: true, data, requestId: 'read' });
});

describe('resume reads authority before delegating a single same-ID operation', () => {
  it.each([
    ['paused', undefined, '/wake'],
    ['stopped', lifecycle, '/snapshots/snap%2Fa%20%2B/restore'],
  ])('resumes %s with the caller key and encoded path', async (state, managed, suffix) => {
    const {client, fetch, write} = setup({ ...status, state, lifecycle: managed });
    expect(await client.environments.resume(status.environmentId, { idempotencyKey: 'stable-key' })).toEqual(write);
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://eaas.invalid/api/v1/environments/env%2Fa%20%2B', 'GET'],
      [`https://eaas.invalid/api/v1/environments/env%2Fa%20%2B${suffix}`, 'POST'],
    ]);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Idempotency-Key')).toBe('stable-key');
  });
  it.each(['running', 'degraded', 'provisioning'] as const)('returns current %s coordinates without writing or claiming readiness', async state => {
    const {client, fetch} = setup({ ...status, state });
    expect(await client.environments.resume(status.environmentId)).toEqual({ success: true, data: { environmentId: status.environmentId, state, revision: 4, epoch: 2, operationId: null }, requestId: 'read' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['stopped', undefined], ['errored', lifecycle], ['pending', lifecycle], ['stopping', lifecycle],
    ['stopped', { ...lifecycle, recoverable: false }], ['stopped', { ...lifecycle, latestSnapshotId: null }],
    ['stopped', { ...lifecycle, latestSnapshotId: '' }], ['stopped', { ...lifecycle, mode: 'legacy' }],
  ])('rejects unavailable checkpoint for %s (%j) without mutation', async (state, managed) => {
    const {client, fetch} = setup({ ...status, state, lifecycle: managed });
    expect(await client.environments.resume(status.environmentId)).toMatchObject({ success: false, requestId: 'read', error: { code: 'state_conflict', details: { reason: 'checkpoint_unavailable' } } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([403, 503])('preserves HTTP %s GET denial, fields, requestId and Retry-After', async http => {
    const failure = { success: false, error: { code: http === 403 ? 'scope_denied' : 'provider_unavailable', message: 'denied', details: { poolId: 'p' }, retryable: false }, requestId: 'denial', extra: 'forward-compatible' };
    const fetch = vi.fn(async () => new Response(JSON.stringify(failure), { status: http, headers: { 'Retry-After': '7' } }));
    const client = new PrismerClient({ apiKey: 'sk-eaas-synthetic', baseUrl: 'https://eaas.invalid', fetch });
    expect(await client.environments.resume(status.environmentId)).toEqual({ ...failure, ok: false, error: { ...failure.error, retryAfterMs: 7000 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry a delegated write rejection and preserves its metadata', async () => {
    const failure = { success: false, error: { code: 'provider_unavailable', message: 'busy', details: { retry: 'caller' }, retryAfterMs: 3000 }, requestId: 'write-failure' };
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'GET' ? { success: true, data: { ...status, state: 'paused' }, requestId: 'read' } : failure), { status: init?.method === 'GET' ? 200 : 503, headers: init?.method === 'GET' ? {} : { 'Retry-After': '3' } }));
    const client = new PrismerClient({ apiKey: 'sk-eaas-synthetic', baseUrl: 'https://eaas.invalid', fetch });
    expect(await client.environments.resume(status.environmentId, {idempotencyKey:'same'})).toEqual({ ...failure, ok: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('returns the GET failure object itself at the subclient seam', async () => {
    const failure = { success: false as const, error: { code: 'provider_unavailable', message: 'busy', details: { poolId: 'p' }, retryAfterMs: 7000 }, requestId: 'denial', extra: 'future' };
    const request = vi.fn(async () => failure);
    const client = new EnvironmentsClient(request, vi.fn());
    expect(await client.resume(status.environmentId)).toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps a supplied key stable across caller-initiated retries', async () => {
    const { client, fetch } = setup({ ...status, state: 'paused' });
    await client.environments.resume(status.environmentId, { idempotencyKey: 'once' });
    await client.environments.resume(status.environmentId, { idempotencyKey: 'once' });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual(['once', 'once']);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

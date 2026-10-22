/**
 * `cloud load` / `cloud search` (top-level shortcuts) and `cloud context search` must
 * default to Load navigation and print the refs an agent needs for the next hop.
 *
 * Real HTTP server + the real CLI entry (spawned through tsx) — the oracle is the
 * request body the server received and the refs present on stdout.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { register as registerContext } from '../src/commands/context';
import { makeRealClient, runCli } from './helpers/fake-cloud';

const execFileAsync = promisify(execFile);
const API_KEY = 'sk-prismer-live-testkey00000000000000000000000000000000000000000000000000';
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_PATH = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SNAPSHOT = 'a'.repeat(64);
const SECTION_REF = `prismer://load/${SNAPSHOT}/n1`;
const cleanups: Array<() => Promise<void>> = [];

const NAVIGATION = {
  success: true,
  mode: 'navigate',
  guidance: 'An outline is not the document text.',
  results: [
    {
      status: 'ok',
      url: 'https://example.com/',
      title: 'Example',
      ref: `prismer://load/${SNAPSHOT}/root`,
      view: 'outline',
      outline: [{ title: 'Install', ref: SECTION_REF, hasChildren: false, estimatedTokens: 40 }],
      outlineComplete: true,
    },
  ],
  next_calls: [{ input: [SECTION_REF], view: 'content', budget: { maxTokens: 4000 } }],
};

async function startCloud() {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      bodies.push(body);
      const legacy = Boolean((body.return as { format?: string } | undefined)?.format);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          legacy
            ? { success: true, mode: 'single_url', result: { url: 'https://example.com/', hqcc: 'compressed', cached: true } }
            : NAVIGATION,
        ),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  cleanups.push(() => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))));
  return { baseUrl: `http://127.0.0.1:${address.port}`, bodies };
}

async function runTopLevel(baseUrl: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const home = await mkdtemp(resolve(tmpdir(), 'cloud-load-nav-'));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(
    resolve(home, 'config.toml'),
    `[default]\napi_key = "${API_KEY}"\nbase_url = "${baseUrl}"\nenvironment = "production"\n`,
  );
  try {
    const result = await execFileAsync(resolve(REPO_ROOT, 'node_modules/.bin/tsx'), [CLI_PATH, ...args], {
      env: { ...process.env, PRISMER_HOME: home, NO_COLOR: '1' },
    });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string };
    return { exitCode: typeof failed.code === 'number' ? failed.code : 1, stdout: failed.stdout ?? '' };
  }
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('cloud load / search navigation output', () => {
  it('cloud load <url> requests navigation and prints the section refs', async () => {
    const cloud = await startCloud();
    const out = await runTopLevel(cloud.baseUrl, ['load', 'https://example.com/']);
    expect(out.exitCode).toBe(0);
    expect(cloud.bodies[0]).toMatchObject({ input: 'https://example.com/', view: 'navigate', budget: { maxTokens: 4000 } });
    expect(cloud.bodies[0]).not.toHaveProperty('return');
    expect(out.stdout).toContain(SECTION_REF);
  }, 30_000);

  it('cloud load <ref...> --max-tokens forwards the refs and the budget', async () => {
    const cloud = await startCloud();
    const out = await runTopLevel(cloud.baseUrl, ['load', SECTION_REF, `${SECTION_REF}?view=content`, '--max-tokens', '8000']);
    expect(out.exitCode).toBe(0);
    expect(cloud.bodies[0]).toMatchObject({ input: [SECTION_REF, `${SECTION_REF}?view=content`], budget: { maxTokens: 8000 } });
  }, 30_000);

  it('an explicit legacy --format keeps the legacy path', async () => {
    const cloud = await startCloud();
    const out = await runTopLevel(cloud.baseUrl, ['load', 'https://example.com/', '--format', 'hqcc']);
    expect(out.exitCode).toBe(0);
    expect(cloud.bodies[0]).toMatchObject({ return: { format: 'hqcc' } });
    expect(cloud.bodies[0].view).toBeUndefined();
    expect(out.stdout).toContain('compressed');
  }, 30_000);

  it('cloud search <query> prints the outline refs, not just a URL table', async () => {
    const cloud = await startCloud();
    const out = await runTopLevel(cloud.baseUrl, ['search', 'example install guide']);
    expect(out.exitCode).toBe(0);
    expect(cloud.bodies[0]).toMatchObject({ input: 'example install guide', view: 'navigate', inputType: 'query' });
    expect(out.stdout).toContain(SECTION_REF);
  }, 30_000);

  it('cloud context search <query> prints the outline refs', async () => {
    const cloud = await startCloud();
    const out = await runCli(registerContext, makeRealClient(cloud.baseUrl), ['context', 'search', 'example install guide']);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain(SECTION_REF);
  });
});

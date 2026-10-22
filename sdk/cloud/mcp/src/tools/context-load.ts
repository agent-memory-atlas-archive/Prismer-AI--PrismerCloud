import { z } from 'zod';
import { prismerFetch } from '../lib/client.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerContextLoad(server: McpServer) {
  server.tool(
    'prismer.context.load',
    'Search or load a URL to get an outline. Call this same tool again with returned refs to read original sections from cache. Pass an array for batch expansion. Follow nextRef only when more evidence is needed; an outline is not the full document.',
    {
      input: z
        .union([z.string(), z.array(z.string()).min(1).max(20)])
        .describe('URL, search query, returned ref, or array of URLs/refs'),
      view: z.enum(['navigate', 'outline', 'content']).optional(),
      maxTokens: z.number().int().min(512).max(16000).optional(),
      format: z
        .enum(['hqcc', 'raw', 'both'])
        .optional()
        .describe('Output format. hqcc = legacy compressed, raw = original, both = both'),
      maxResults: z
        .number()
        .optional()
        .describe('Max results for search queries (default: 5)'),
      ranking: z
        .enum(['cache_first', 'relevance_first', 'balanced'])
        .optional()
        .describe('Ranking preset for search results (default: cache_first)'),
    },
    async ({ input, format, maxResults, ranking, view, maxTokens }) => {
      try {
        const body: Record<string, unknown> = { input };
        if (!format || view) body.view = view || 'navigate';
        if (maxTokens) body.budget = { maxTokens };
        if (format) body['return'] = { format };
        if (maxResults) body['return'] = { ...(body['return'] as object || {}), topK: maxResults };
        if (ranking) body.ranking = { preset: ranking };

        const result = (await prismerFetch('/api/context/load', {
          method: 'POST',
          body,
        })) as Record<string, unknown>;

        if (!result.success) {
          const err = result.error as Record<string, string> | undefined;
          return { content: [{ type: 'text' as const, text: `Error: ${err?.message || 'Unknown error'}` }] };
        }

        const data = result as Record<string, unknown>;
        if (data.mode === 'navigate') {
          const calls = (data.next_calls as Array<Record<string, any>> || []).map(call => ({
            tool: 'prismer.context.load', arguments: { input: call.input, view: call.view, maxTokens: call.budget?.maxTokens },
          }));
          return {content:[{type:'text' as const,text:JSON.stringify({...data,next_calls:calls})}]};
        }
        let text = '';

        // Single URL result
        if (data.result) {
          const r = data.result as Record<string, unknown>;
          text += `## ${r.title || r.url}\n`;
          text += `Source: ${r.url}\n`;
          if (r.cached) text += '(from global cache — free)\n';
          text += `\n${r.hqcc || r.raw || r.content || ''}\n`;
        }

        // Multiple results (search or batch)
        if (data.results && Array.isArray(data.results)) {
          for (const r of data.results as Record<string, unknown>[]) {
            text += `## ${r.title || r.url}\n`;
            text += `Source: ${r.url}\n`;
            if (r.cached) text += '(cached — free)\n';
            text += `\n${r.hqcc || r.raw || r.content || ''}\n\n---\n\n`;
          }
        }

        // Summary
        if (data.summary) {
          const s = data.summary as Record<string, unknown>;
          text += `\n---\nQuery: "${s.query}" | Searched: ${s.searched} | Cache hits: ${s.cacheHits} | Returned: ${s.returned}\n`;
        }
        if (data.cost) {
          const c = data.cost as Record<string, unknown>;
          const saved = c.savedByCache ? ` (saved ${c.savedByCache} from cache)` : '';
          text += `Cost: ${c.totalCredits ?? c.credits ?? 0} credits${saved}\n`;
        }

        return { content: [{ type: 'text' as const, text: text || JSON.stringify(data) }] };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${msg}` }] };
      }
    }
  );
}

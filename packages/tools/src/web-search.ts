import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip } from './format';

const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 8;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  name: string;
  search(query: string, maxResults: number): Promise<WebSearchResult[]>;
}

export interface WebSearchProviderOptions {
  provider: 'tavily' | 'brave';
  getApiKey: () => string;
}

export function createWebSearchProvider(opts: WebSearchProviderOptions): WebSearchProvider {
  if (opts.provider === 'tavily') {
    return {
      name: 'tavily',
      search: async (query, maxResults) => {
        const response = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${opts.getApiKey()}`,
          },
          body: JSON.stringify({ query, max_results: maxResults }),
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`tavily returned ${response.status}: ${await response.text()}`);
        }
        const payload = (await response.json()) as {
          results?: { title?: string; url?: string; content?: string }[];
        };
        return (payload.results ?? []).map((entry) => ({
          title: entry.title ?? '',
          url: entry.url ?? '',
          snippet: entry.content ?? '',
        }));
      },
    };
  }
  return {
    name: 'brave',
    search: async (query, maxResults) => {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(maxResults));
      const response = await fetch(url.toString(), {
        headers: {
          accept: 'application/json',
          'X-Subscription-Token': opts.getApiKey(),
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`brave returned ${response.status}: ${await response.text()}`);
      }
      const payload = (await response.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      return (payload.web?.results ?? []).map((entry) => ({
        title: entry.title ?? '',
        url: entry.url ?? '',
        snippet: entry.description ?? '',
      }));
    },
  };
}

const SEARCH_SCHEMA = z.object({
  query: z.string().describe('The search query.'),
  max_results: z.number().int().positive().max(20).optional().describe('Default 8.'),
});
type SearchArgs = z.infer<typeof SEARCH_SCHEMA>;
type SearchResult = { results: WebSearchResult[] } | { error: string };

export function buildWebSearchTool(ctx: ToolContext) {
  return defineTool<SearchArgs, SearchResult>({
    description:
      'Search the web and return result titles, URLs, and snippets. ' +
      'Follow up with the fetch tool to read a promising result.',
    inputSchema: SEARCH_SCHEMA,
    execute: async (args) => {
      const provider = ctx.webSearch;
      if (!provider) {
        return { error: 'web search is not configured for this session' };
      }
      try {
        const results = await provider.search(args.query, args.max_results ?? DEFAULT_MAX_RESULTS);
        return { results };
      } catch (err) {
        return { error: `search failed: ${(err as Error)?.message ?? String(err)}` };
      }
    },
    formatScrollback: (args, result) => {
      const head = clip(args.query, 60);
      if (!result) return { summary: head };
      if ('error' in result) return { summary: `${head} (${clip(result.error, 40)})` };
      return { summary: `${head} (${result.results.length} results)` };
    },
  });
}

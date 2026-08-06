import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { buildWebSearchTool, createWebSearchProvider } from '../src/web-search';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };
const asAny = (def: { tool: unknown }) => def.tool as AnyTool;

function makeCtx(provider: ReturnType<typeof createWebSearchProvider>): ToolContext {
  const executor = new LocalExecutor({ cwd: '/tmp' });
  return {
    sandboxExecutor: executor,
    hostExecutor: executor,
    sandboxMode: 'off',
    webSearch: provider,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('web_search tool', () => {
  it('tavily provider posts the query and maps results', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: 'Result A', url: 'https://a.example', content: 'snippet a' },
              { title: 'Result B', url: 'https://b.example', content: 'snippet b' },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createWebSearchProvider({
      provider: 'tavily',
      getApiKey: () => 'tvly-key',
    });
    const tool = asAny(buildWebSearchTool(makeCtx(provider)));
    const result = await tool.execute({ query: 'chimera agent' }, {});

    expect(result.results).toEqual([
      { title: 'Result A', url: 'https://a.example', snippet: 'snippet a' },
      { title: 'Result B', url: 'https://b.example', snippet: 'snippet b' },
    ]);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('tavily.com');
    expect(JSON.parse(init.body as string).query).toBe('chimera agent');
    expect((init.headers as Record<string, string>).Authorization).toContain('tvly-key');
  });

  it('searxng provider queries the configured instance and limits normalized results', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: 'Result A', url: 'https://a.example', content: 'snippet a' },
              { title: 'Result B', url: 'https://b.example', content: 'snippet b' },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createWebSearchProvider({
      provider: 'searxng',
      baseUrl: 'http://search.example:8181/',
    });
    const tool = asAny(buildWebSearchTool(makeCtx(provider)));
    const result = await tool.execute({ query: 'chimera agent', max_results: 1 }, {});

    expect(result.results).toEqual([
      { title: 'Result A', url: 'https://a.example', snippet: 'snippet a' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('http://search.example:8181/search?q=chimera+agent&format=json');
  });

  it('searxng provider preserves a path-prefixed base URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createWebSearchProvider({
      provider: 'searxng',
      baseUrl: 'https://example.com/private/search-instance',
    });
    await provider.search('path test', 3);

    const [url] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://example.com/private/search-instance/search?q=path+test&format=json');
  });

  it('searxng errors surface without falling back to another provider', async () => {
    const fetchMock = vi.fn(async () => new Response('json format disabled', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = createWebSearchProvider({
      provider: 'searxng',
      baseUrl: 'https://search.example',
    });
    const tool = asAny(buildWebSearchTool(makeCtx(provider)));
    const result = await tool.execute({ query: 'private query' }, {});

    expect(result.error).toBe('search failed: searxng returned 403: json format disabled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toContain('search.example');
  });

  it('brave provider sends the query as a GET with the key header', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            web: {
              results: [{ title: 'Brave A', url: 'https://a.example', description: 'desc a' }],
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = createWebSearchProvider({
      provider: 'brave',
      getApiKey: () => 'brave-key',
    });
    const tool = asAny(buildWebSearchTool(makeCtx(provider)));
    const result = await tool.execute({ query: 'rust tokio', max_results: 3 }, {});

    expect(result.results).toEqual([
      { title: 'Brave A', url: 'https://a.example', snippet: 'desc a' },
    ]);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('search.brave.com');
    expect(url).toContain('q=rust+tokio');
    expect((init.headers as Record<string, string>)['X-Subscription-Token']).toBe('brave-key');
  });

  it('surfaces provider errors as a result error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('rate limited', { status: 429 })),
    );
    const provider = createWebSearchProvider({
      provider: 'tavily',
      getApiKey: () => 'tvly-key',
    });
    const tool = asAny(buildWebSearchTool(makeCtx(provider)));
    const result = await tool.execute({ query: 'q' }, {});
    expect(result.error).toMatch(/429/);
  });
});

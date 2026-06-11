import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PermissionGate, PermissionRequest, PermissionResolution } from '@chimera/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/context';
import { LocalExecutor } from '../src/local-executor';
import { buildFetchTool, htmlToText } from '../src/web';

type AnyTool = { execute: (args: any, opts?: any) => Promise<any> };
const asAny = (def: { tool: unknown }) => def.tool as AnyTool;

class FakeGate implements PermissionGate {
  request = vi.fn(
    async (_req: PermissionRequest): Promise<PermissionResolution> => ({
      decision: 'allow',
      remembered: false,
    }),
  );
  check = vi.fn(() => null);
  addRule = vi.fn();
  listRules = vi.fn(() => []);
  removeRule = vi.fn();
}

describe('htmlToText', () => {
  it('strips tags, scripts, and styles down to readable text', () => {
    const html = `
      <html><head><title>T</title><style>.a{color:red}</style>
      <script>alert(1)</script></head>
      <body><h1>Heading</h1><p>First <strong>para</strong>.</p>
      <ul><li>one</li><li>two</li></ul>
      <a href="https://example.com/docs">docs link</a></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('# Heading');
    expect(text).toContain('First para.');
    expect(text).toContain('- one');
    expect(text).toContain('- two');
    expect(text).toContain('[docs link](https://example.com/docs)');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('color:red');
  });

  it('decodes common entities', () => {
    expect(htmlToText('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>')).toBe(
      'a & b <c> "d" \'e\'',
    );
  });
});

describe('fetch tool', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.setHeader('content-type', 'text/html');
        res.end('<html><body><h1>Hello</h1><p>World</p></body></html>');
      } else if (req.url === '/plain') {
        res.setHeader('content-type', 'text/plain');
        res.end('just text');
      } else if (req.url === '/big') {
        res.setHeader('content-type', 'text/plain');
        res.end('x'.repeat(100_000));
      } else {
        res.statusCode = 404;
        res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  function makeCtx(gate: FakeGate): ToolContext {
    const executor = new LocalExecutor({ cwd: '/tmp' });
    return {
      sandboxExecutor: executor,
      hostExecutor: executor,
      sandboxMode: 'off',
      permissionGate: gate,
    };
  }

  it('fetches a page and converts it to text', async () => {
    const gate = new FakeGate();
    const fetchTool = asAny(buildFetchTool(makeCtx(gate)));
    const result = await fetchTool.execute({ url: `${baseUrl}/page` }, {});
    expect(result.content).toContain('# Hello');
    expect(result.content).toContain('World');
    expect(result.status).toBe(200);
    expect(gate.request).toHaveBeenCalledOnce();
    expect(gate.request.mock.calls[0]![0].tool).toBe('fetch');
    expect(gate.request.mock.calls[0]![0].command).toBe(`${baseUrl}/page`);
  });

  it('returns plain text untouched', async () => {
    const gate = new FakeGate();
    const fetchTool = asAny(buildFetchTool(makeCtx(gate)));
    const result = await fetchTool.execute({ url: `${baseUrl}/plain` }, {});
    expect(result.content).toBe('just text');
  });

  it('clips oversized responses', async () => {
    const gate = new FakeGate();
    const fetchTool = asAny(buildFetchTool(makeCtx(gate)));
    const result = await fetchTool.execute({ url: `${baseUrl}/big`, max_chars: 1000 }, {});
    expect(result.content.length).toBeLessThan(1100);
    expect(result.truncated).toBe(true);
  });

  it('refuses when the gate denies', async () => {
    const gate = new FakeGate();
    gate.request.mockResolvedValueOnce({
      decision: 'deny',
      remembered: false,
      denialSource: 'user',
    });
    const fetchTool = asAny(buildFetchTool(makeCtx(gate)));
    const result = await fetchTool.execute({ url: `${baseUrl}/page` }, {});
    expect(result.error).toMatch(/denied/);
    expect(result.content).toBeUndefined();
  });

  it('rejects non-http(s) schemes without consulting the gate', async () => {
    const gate = new FakeGate();
    const fetchTool = asAny(buildFetchTool(makeCtx(gate)));
    const result = await fetchTool.execute({ url: 'file:///etc/passwd' }, {});
    expect(result.error).toMatch(/http/);
    expect(gate.request).not.toHaveBeenCalled();
  });

  it('reports non-2xx statuses alongside the body', async () => {
    const gate = new FakeGate();
    const fetchTool = asAny(buildFetchTool(makeCtx(gate)));
    const result = await fetchTool.execute({ url: `${baseUrl}/missing` }, {});
    expect(result.status).toBe(404);
    expect(result.content).toContain('not found');
  });
});

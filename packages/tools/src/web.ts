import { newRequestId } from '@chimera/core';
import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';
import { clip } from './format';

const DEFAULT_MAX_CHARS = 50_000;
const FETCH_TIMEOUT_MS = 30_000;

const FETCH_SCHEMA = z.object({
  url: z.string().describe('The http(s) URL to fetch.'),
  max_chars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Truncate the converted content to this many characters. Default 50000.'),
});
type FetchArgs = z.infer<typeof FETCH_SCHEMA>;
type FetchResult =
  | { url: string; status: number; content: string; truncated: boolean }
  | { error: string };

export function buildFetchTool(ctx: ToolContext) {
  return defineTool<FetchArgs, FetchResult>({
    description:
      'Fetch a URL and return its content as readable text (HTML is converted to a ' +
      'markdown-ish plain form). Use for documentation, READMEs, issues, and error lookups.',
    inputSchema: FETCH_SCHEMA,
    execute: async (args, { abortSignal }) => {
      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        return { error: `invalid URL: ${args.url}` };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { error: 'only http(s) URLs are supported' };
      }
      if (ctx.permissionGate) {
        const resolution = await ctx.permissionGate.request({
          requestId: newRequestId(),
          tool: 'fetch',
          target: 'host',
          command: args.url,
          cwd: ctx.hostExecutor.cwd(),
        });
        if (resolution.decision === 'deny') {
          return { error: 'denied by user' };
        }
      }
      const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
      try {
        const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS)];
        if (abortSignal) signals.push(abortSignal);
        const response = await fetch(args.url, {
          redirect: 'follow',
          signal: AbortSignal.any(signals),
          headers: { 'user-agent': 'chimera-agent/0.1', accept: 'text/html, text/*, */*' },
        });
        const body = await response.text();
        const contentType = response.headers.get('content-type') ?? '';
        const text = contentType.includes('html') ? htmlToText(body) : body;
        const truncated = text.length > maxChars;
        return {
          url: response.url,
          status: response.status,
          content: truncated ? `${text.slice(0, maxChars)}\n... (truncated)` : text,
          truncated,
        };
      } catch (err) {
        return { error: `fetch failed: ${(err as Error)?.message ?? String(err)}` };
      }
    },
    formatScrollback: (args, result) => {
      const head = clip(args.url, 70);
      if (!result) return { summary: head };
      if ('error' in result) return { summary: `${head} (${clip(result.error, 40)})` };
      const size = `${result.content.length} chars${result.truncated ? ', truncated' : ''}`;
      return { summary: `${head} (${result.status}, ${size})` };
    },
  });
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'br',
  'tr',
  'table',
  'blockquote',
  'pre',
  'form',
]);

/**
 * Minimal dependency-free HTML→text conversion: drops script/style/head
 * content, renders headings as `#`, list items as `-`, links as
 * `[text](href)`, and collapses whitespace. Not a spec-grade parser — good
 * enough for docs pages and READMEs the agent wants to read.
 */
export function htmlToText(html: string): string {
  let working = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|head|svg|iframe)\b[\s\S]*?<\/\1>/gi, '');

  working = working
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
      return `\n\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n\n`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
      return `\n- ${stripTags(inner).trim()}`;
    })
    .replace(
      /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, inner: string) => {
        const label = stripTags(inner).trim();
        return label ? `[${label}](${href})` : href;
      },
    );

  working = working.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_m, tag: string) =>
    BLOCK_TAGS.has(tag.toLowerCase()) ? '\n\n' : '',
  );

  return collapseWhitespace(decodeEntities(working));
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function collapseWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

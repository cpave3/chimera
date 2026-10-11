import { common, createLowlight } from 'lowlight';
import type { SyntaxTokens } from './theme/types';

export type SyntaxToken = keyof SyntaxTokens;

export interface CodeSegment {
  text: string;
  token?: SyntaxToken;
}

const lowlight = createLowlight(common);

/** Blocks longer than this render plain: highlighting them costs more than it shows. */
const MAX_HIGHLIGHT_LINES = 400;

// highlight.js scope classes, folded onto the six colours a theme defines.
const TOKEN_BY_CLASS: Record<string, SyntaxToken> = {
  'hljs-keyword': 'keyword',
  'hljs-literal': 'keyword',
  'hljs-name': 'keyword',
  'hljs-selector-tag': 'keyword',
  'hljs-string': 'string',
  'hljs-regexp': 'string',
  'hljs-addition': 'string',
  'hljs-comment': 'comment',
  'hljs-meta': 'comment',
  'hljs-doctag': 'comment',
  'hljs-number': 'number',
  'hljs-symbol': 'number',
  'hljs-deletion': 'number',
  'hljs-title': 'function',
  'hljs-section': 'function',
  'hljs-type': 'type',
  'hljs-built_in': 'type',
  'hljs-attr': 'type',
  'hljs-attribute': 'type',
  'hljs-variable': 'type',
};

type SyntaxNode =
  | { type: 'text'; value: string }
  | { type: 'element'; properties?: { className?: unknown }; children: SyntaxNode[] };

function tokenOf(node: Extract<SyntaxNode, { type: 'element' }>): SyntaxToken | undefined {
  const classes = node.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  for (const name of classes) {
    const token = TOKEN_BY_CLASS[String(name)];
    if (token) return token;
  }
  return undefined;
}

/**
 * Split `code` into lines of coloured segments. Returns undefined when the
 * language is unknown or the block is too long; the caller then renders the
 * block as plain text.
 */
export function highlightCode(
  code: string,
  language: string | undefined,
): CodeSegment[][] | undefined {
  if (!language || !lowlight.registered(language)) return undefined;
  if (code.split('\n').length > MAX_HIGHLIGHT_LINES) return undefined;

  const lines: CodeSegment[][] = [[]];
  const append = (text: string, token: SyntaxToken | undefined) => {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== '') lines.at(-1)!.push(token ? { text: part, token } : { text: part });
    });
  };
  const walk = (nodes: SyntaxNode[], inherited: SyntaxToken | undefined) => {
    for (const node of nodes) {
      if (node.type === 'text') append(node.value, inherited);
      else walk(node.children, tokenOf(node) ?? inherited);
    }
  };
  walk(lowlight.highlight(language, code).children as SyntaxNode[], undefined);
  return lines;
}

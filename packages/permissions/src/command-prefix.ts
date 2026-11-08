import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as TreeSitter from 'web-tree-sitter';
import { bashGrammarPath } from './grammar';

let parserInitialization: Promise<TreeSitter.Parser> | undefined;
const executionWrappers = new Set([
  'bash',
  'sh',
  'dash',
  'zsh',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'env',
  'sudo',
  'doas',
  'su',
  'eval',
  'exec',
  'command',
  'builtin',
  'source',
  '.',
  'nohup',
  'nice',
  'ionice',
  'timeout',
  'setsid',
  'xargs',
  'time',
  'busybox',
  'ash',
  'mksh',
  'yash',
  'rbash',
  'rksh',
  'rzsh',
  'stdbuf',
  'chroot',
  'runuser',
  'runcon',
  'setpriv',
  'unshare',
  'nsenter',
  'flock',
  'watch',
  'parallel',
  'ssh',
]);

export async function matchesCommandPrefix(command: string, prefix: string): Promise<boolean> {
  const parser = await getParser();
  const commandTokens = literalTokens(parser, command);
  const prefixTokens = literalTokens(parser, prefix);
  return (
    commandTokens !== undefined &&
    prefixTokens !== undefined &&
    prefixTokens.length <= commandTokens.length &&
    prefixTokens.every((token, index) => token === commandTokens[index])
  );
}

async function getParser(): Promise<TreeSitter.Parser> {
  parserInitialization ??= (async () => {
    await TreeSitter.Parser.init();
    const language = await TreeSitter.Language.load(readFileSync(bashGrammarPath()));
    const parser = new TreeSitter.Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserInitialization;
}

function literalTokens(parser: TreeSitter.Parser, source: string): string[] | undefined {
  if (source.includes('\0')) return undefined;
  const tree = parser.parse(source);
  try {
    if (!tree || tree.rootNode.hasError) return undefined;
    const root = tree.rootNode;
    if (root.children.length !== 1 || root.firstChild?.type !== 'command') return undefined;
    const invocation = root.firstChild;
    if (invocation.firstChild?.type !== 'command_name') return undefined;
    const tokens: string[] = [];
    for (const child of invocation.children) {
      const token = literalWord(child);
      if (token === undefined) return undefined;
      tokens.push(token);
    }
    if (!tokens[0] || executionWrappers.has(basename(tokens[0]))) return undefined;
    return tokens;
  } finally {
    tree?.delete();
  }
}

function literalWord(node: TreeSitter.Node): string | undefined {
  if (!hasOnlyLiteralNodes(node)) return undefined;
  let quote: string | undefined;
  let value = '';
  const text = node.text;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else value += character;
    } else if (character === quote) {
      quote = undefined;
    } else if (character === '\\') {
      const escaped = text[++index];
      if (escaped === undefined || escaped === '\n') return undefined;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(escaped)) value += '\\';
      value += escaped;
    } else if (!quote && (character === "'" || character === '"')) {
      quote = character;
    } else {
      if (character === '$' || character === '`') return undefined;
      // The Bash grammar also represents glob, tilde, and brace expansions as plain words.
      if (!quote && '~*?[]{}'.includes(character)) return undefined;
      value += character;
    }
  }
  return quote ? undefined : value;
}

function hasOnlyLiteralNodes(node: TreeSitter.Node): boolean {
  return (
    // The Bash grammar gives a bare integer argument its own `number` node.
    [
      'command_name',
      'word',
      'number',
      'raw_string',
      'string',
      'string_content',
      'concatenation',
    ].includes(node.type) && node.namedChildren.every(hasOnlyLiteralNodes)
  );
}

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type {
  CommandPolicyFinding,
  CommandPolicyStage,
  CommandPolicyStageContext,
  CommandPolicyStageResult,
} from '@chimera/core';
import * as TreeSitter from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const grammarPath = join(
  dirname(require.resolve('@aslamplr/pi-safe-shell/package.json')),
  'src/tree-sitter-bash.wasm',
);
let parserInitialization: Promise<TreeSitter.Parser> | undefined;

interface SudoInvocation {
  args: string[];
}

interface SudoAnalysis {
  invocations: SudoInvocation[];
  dynamicExecutable: boolean;
}

export class SudoApprovalStage implements CommandPolicyStage {
  readonly id = 'sudo_approval';

  async evaluate(context: CommandPolicyStageContext): Promise<CommandPolicyStageResult> {
    const analysis = await analyzeSudo(context.command);
    if (analysis.invocations.length === 0 && !analysis.dynamicExecutable) return { status: 'pass' };

    const findings: CommandPolicyFinding[] = [
      {
        kind: 'elevation',
        stageId: this.id,
        ruleId: 'sudo',
        message: 'sudo requires one-time approval and local authentication.',
      },
    ];
    if (analysis.invocations.some((invocation) => invalidatesCredentials(invocation.args))) {
      findings.push({
        kind: 'blocked',
        stageId: this.id,
        ruleId: 'sudo-credential-invalidation',
        message: 'Commands that invalidate sudo credentials are not supported by Chimera.',
      });
    }
    return { status: 'findings', findings };
  }
}

export async function commandRequiresSudo(command: string): Promise<boolean> {
  const analysis = await analyzeSudo(command);
  return analysis.invocations.length > 0 || analysis.dynamicExecutable;
}

async function analyzeSudo(command: string): Promise<SudoAnalysis> {
  const parser = await getParser();
  const tree = parser.parse(command);
  try {
    if (!tree) throw new Error('failed to parse shell command');
    const invocations: SudoInvocation[] = [];
    collectSudoInvocations(tree.rootNode, invocations);
    return {
      invocations,
      dynamicExecutable:
        containsDynamicExecutable(tree.rootNode) || containsNestedSudoScript(tree.rootNode),
    };
  } finally {
    tree?.delete();
  }
}

async function getParser(): Promise<TreeSitter.Parser> {
  parserInitialization ??= (async () => {
    await TreeSitter.Parser.init();
    const language = await TreeSitter.Language.load(readFileSync(grammarPath));
    const parser = new TreeSitter.Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserInitialization;
}

function collectSudoInvocations(node: TreeSitter.Node, invocations: SudoInvocation[]): void {
  if (node.type === 'command') {
    const invocation = parseSudoInvocation(node);
    if (invocation) invocations.push(invocation);
  }
  for (const child of node.namedChildren) collectSudoInvocations(child, invocations);
}

function containsDynamicExecutable(node: TreeSitter.Node): boolean {
  if (
    node.type === 'command_name' &&
    node.namedChildren.some((child) =>
      ['simple_expansion', 'expansion', 'command_substitution'].includes(child.type),
    )
  ) {
    return true;
  }
  return node.namedChildren.some(containsDynamicExecutable);
}

function containsNestedSudoScript(node: TreeSitter.Node): boolean {
  if (node.type === 'command') {
    const words = node.namedChildren.filter((child) =>
      ['command_name', 'word', 'raw_string', 'string'].includes(child.type),
    );
    const executable = baseName(words[0]?.text);
    const scriptIndex = findNestedScriptIndex(
      executable,
      words.map((word) => word.text),
    );
    const scriptNode = words[scriptIndex];
    if (scriptNode?.namedChildren.length) return true;
    const script = unquoteStaticWord(scriptNode?.text ?? '');
    if (scriptIndex >= 0 && /(^|[;&|()\s])sudo([;&|()\s]|$)/.test(script)) return true;
  }
  return node.namedChildren.some(containsNestedSudoScript);
}

function findNestedScriptIndex(executable: string, words: string[]): number {
  if (executable === 'eval') return words.length > 1 ? 1 : -1;
  if (!['sh', 'bash'].includes(executable)) return -1;
  const commandOption = words.findIndex((word) => word === '-c' || /^-[^-]*c/.test(word));
  if (commandOption < 0) return -1;
  let scriptIndex = commandOption + 1;
  if (words[scriptIndex] === '--') scriptIndex++;
  return scriptIndex < words.length ? scriptIndex : -1;
}

function parseSudoInvocation(command: TreeSitter.Node): SudoInvocation | undefined {
  const words = command.namedChildren
    .filter((child) => child.type === 'command_name' || child.type === 'word')
    .map((child) => child.text);
  let index = 0;
  while (isAssignment(words[index])) index++;
  while (['command', 'env'].includes(baseName(words[index]))) {
    const wrapper = baseName(words[index++]);
    index = skipWrapperOptions(wrapper, words, index);
    while (isAssignment(words[index])) index++;
  }
  if (baseName(words[index]) !== 'sudo') return undefined;
  return { args: words.slice(index + 1) };
}

function skipWrapperOptions(wrapper: string, words: string[], start: number): number {
  let index = start;
  while (words[index]?.startsWith('-')) {
    const option = words[index++];
    if (option === '--') break;
    if (
      wrapper === 'env' &&
      ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(option)
    ) {
      index++;
    }
  }
  return index;
}

function invalidatesCredentials(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') return false;
    if (!arg.startsWith('-') || arg === '-') return false;
    if (arg === '--reset-timestamp' || arg === '--remove-timestamp') return true;
    const shortOptions = parseSudoShortOptions(arg);
    if (shortOptions.includes('k') || shortOptions.includes('K')) return true;
    if (sudoOptionConsumesValue(arg)) index++;
  }
  return false;
}

function parseSudoShortOptions(option: string): string[] {
  if (!/^-[^-]/.test(option)) return [];
  const options: string[] = [];
  for (const shortOption of option.slice(1)) {
    options.push(shortOption);
    if ('CDghpRrtu'.includes(shortOption)) break;
  }
  return options;
}

function sudoOptionConsumesValue(option: string): boolean {
  return [
    '-C',
    '--close-from',
    '-D',
    '--chdir',
    '-g',
    '--group',
    '-h',
    '--host',
    '-p',
    '--prompt',
    '-R',
    '--chroot',
    '-r',
    '--role',
    '-t',
    '--type',
    '-u',
    '--user',
  ].includes(option);
}

function baseName(value: string | undefined): string {
  return value ? unquoteStaticWord(value).replace(/^.*\//, '') : '';
}

function unquoteStaticWord(value: string): string {
  return value
    .replace(/'([^']*)'/g, '$1')
    .replace(/"([^"$`]*)"/g, '$1')
    .replace(/\\([^\n])/g, '$1');
}

function isAssignment(value: string | undefined): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value ?? '');
}

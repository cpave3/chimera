import type { CommandRegistry } from '@chimera/commands';

export interface SlashCommand {
  name: string;
  description: string;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'List built-in slash commands' },
  { name: '/clear', description: 'Clear the visible scrollback' },
  { name: '/new', description: 'Create and switch to a new session' },
  { name: '/sessions', description: 'List sessions on this instance' },
  { name: '/exit', description: 'Exit the TUI' },
  { name: '/model', description: 'Show or change the active model' },
  { name: '/rules', description: 'List permission rules (/rules rm <n> to delete)' },
  { name: '/reload', description: 'Re-read user command files from disk' },
];

export function isBuiltin(name: string): boolean {
  return BUILTIN_COMMANDS.some((c) => c.name === name);
}

/**
 * Return the fuzzy-match hint for an unknown `/name` input, considering both
 * built-ins and (optionally) loaded user templates. Returns null if nothing is
 * close enough.
 */
export function findClosestCommand(
  input: string,
  registry?: CommandRegistry,
): string | null {
  const names = [
    ...BUILTIN_COMMANDS.map((c) => c.name),
    ...(registry ? registry.list().map((c) => `/${c.name}`) : []),
  ];
  if (names.includes(input)) return input;
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const n of names) {
    const d = levenshtein(n, input);
    if (d < bestDistance) {
      bestDistance = d;
      best = n;
    }
  }
  return bestDistance <= 3 ? best : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j]!;
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

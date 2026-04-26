import type { CommandRegistry } from '@chimera/commands';
import type { SkillRegistry } from '@chimera/skills';

export interface SlashCommand {
  name: string;
  description: string;
}

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: '/help', description: 'List built-in slash commands' },
  { name: '/clear', description: 'Clear the visible scrollback' },
  { name: '/new', description: 'Create and switch to a new session' },
  { name: '/sessions', description: 'Pick a session in this dir (/sessions all to see every dir; /sessions tree, /sessions <id> for variants)' },
  { name: '/fork', description: 'Fork the current session into a child (/fork [purpose])' },
  { name: '/exit', description: 'Exit the TUI' },
  { name: '/model', description: 'Show or change the active model' },
  { name: '/rules', description: 'List permission rules (/rules rm <n> to delete)' },
  { name: '/reload', description: 'Re-read user commands and AGENTS.md/CLAUDE.md from disk' },
  { name: '/theme', description: 'List or apply a colour theme (/theme <name>)' },
  { name: '/subagents', description: 'List active subagents of the current session' },
  { name: '/attach', description: 'Attach the TUI to a subagent by id (/attach <id>)' },
  { name: '/detach', description: "Detach from a subagent and return to the parent session" },
];

export const OVERLAY_COMMANDS: SlashCommand[] = [
  { name: '/overlay', description: 'List pending overlay changes' },
  { name: '/apply', description: 'Apply overlay changes (interactive picker)' },
  { name: '/discard', description: 'Discard the overlay upperdir' },
];

export function isBuiltin(name: string): boolean {
  return (
    BUILTIN_COMMANDS.some((c) => c.name === name) ||
    OVERLAY_COMMANDS.some((c) => c.name === name)
  );
}

/**
 * Return the fuzzy-match hint for an unknown `/name` input, considering both
 * built-ins and (optionally) loaded user templates. Returns null if nothing is
 * close enough.
 */
export function findClosestCommand(
  input: string,
  registry?: CommandRegistry,
  skills?: SkillRegistry,
): string | null {
  const names = [
    ...BUILTIN_COMMANDS.map((c) => c.name),
    ...(registry ? registry.list().map((c) => `/${c.name}`) : []),
    ...(skills ? skills.all().map((s) => `/${s.name}`) : []),
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

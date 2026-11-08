import type { CommandRegistry } from '@chimera/commands';
import type { SkillRegistry } from '@chimera/skills';
import { BUILTIN_COMMANDS, OVERLAY_COMMANDS } from '../slash-commands';

export interface SlashMenuItem {
  /** Command name without the leading slash. */
  name: string;
  description?: string;
  kind: 'builtin' | 'user' | 'skill';
}

export interface SlashSources {
  commands?: Pick<CommandRegistry, 'list'>;
  skills?: Pick<SkillRegistry, 'all'>;
  /** The overlay sandbox adds `/apply` and `/discard`. */
  overlay: boolean;
}

/**
 * The slash menu for the prompt text: open for a single-line `/word`, the
 * built-ins first, then commands, then skills, each filtered by the word.
 * A command or skill with the name of one before it is shadowed.
 */
export function slashMenuItems(text: string, sources: SlashSources): SlashMenuItem[] {
  if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) return [];
  const partial = text.slice(1).toLowerCase();
  const builtins = sources.overlay ? [...BUILTIN_COMMANDS, ...OVERLAY_COMMANDS] : BUILTIN_COMMANDS;
  const builtinNames = new Set(builtins.map((command) => command.name));
  const items: SlashMenuItem[] = builtins
    .filter((command) => command.name.toLowerCase().slice(1).includes(partial))
    .map((command) => ({
      name: command.name.slice(1),
      description: command.description,
      kind: 'builtin',
    }));
  const users = (sources.commands?.list() ?? [])
    .filter((command) => !builtinNames.has(`/${command.name}`))
    .filter((command) => command.name.toLowerCase().includes(partial))
    .map(
      (command): SlashMenuItem => ({
        name: command.name,
        description: command.description,
        kind: 'user',
      }),
    );
  const userNames = new Set(users.map((user) => user.name));
  const skills = (sources.skills?.all() ?? [])
    .filter((skill) => !builtinNames.has(`/${skill.name}`) && !userNames.has(skill.name))
    .filter((skill) => skill.name.toLowerCase().includes(partial))
    .map(
      (skill): SlashMenuItem => ({
        name: skill.name,
        description: skill.description,
        kind: 'skill',
      }),
    );
  return [...items, ...users, ...skills];
}

/** Tab on a `/` prefix with no menu: the first built-in, command or skill it starts. */
export function completeSlashPrefix(text: string, sources: SlashSources): string | null {
  if (!text.startsWith('/') || text.includes('\n')) return null;
  const builtin = BUILTIN_COMMANDS.find((command) => command.name.startsWith(text));
  if (builtin) return builtin.name;
  const user = sources.commands?.list().find((command) => `/${command.name}`.startsWith(text));
  if (user) return `/${user.name}`;
  const skill = sources.skills?.all().find((candidate) => `/${candidate.name}`.startsWith(text));
  return skill ? `/${skill.name}` : null;
}

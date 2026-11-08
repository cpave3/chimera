import { type CommandRegistry, InMemoryCommandRegistry } from '@chimera/commands';
import { InMemorySkillRegistry, type SkillRegistry } from '@chimera/skills';
import { afterEach, describe, expect, it } from 'vitest';
import type { MountOptions } from '../src/mount';
import { fakeSession, type Mounted, mount, userMessage } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const tall = { columns: 100, rows: 60 };

function commandRegistry(
  commands: { name: string; body: string; description?: string }[],
): CommandRegistry {
  return new InMemoryCommandRegistry(
    commands.map((command) => ({
      ...command,
      path: `/tmp/${command.name}.md`,
      source: 'project' as const,
    })),
    [],
    '/tmp',
  );
}

function skillRegistry(
  skills: { name: string; description: string; path?: string }[],
): SkillRegistry {
  return new InMemorySkillRegistry(
    skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path ?? `/tmp/.chimera/skills/${skill.name}/SKILL.md`,
      source: 'project' as const,
      frontmatter: {},
    })),
    [],
  );
}

/** Mount on a fake session whose client also has `methods`. */
async function mountWith(
  methods: Record<string, unknown>,
  overrides: Partial<MountOptions> = {},
  size = tall,
) {
  const session = fakeSession();
  Object.assign(session.client, methods);
  mounted = await mount({ client: session.client, ...overrides }, size);
  return { mounted, session };
}

describe('/help', () => {
  it('lists the built-ins and the user commands with their descriptions', async () => {
    const commands = commandRegistry([
      { name: 'summarize', body: 'Summarize $ARGUMENTS', description: 'Summarize stuff' },
    ]);
    mounted = await mount({ commands }, tall);
    await mounted.keys('/help\r');
    const screen = mounted.screen();

    expect(screen).toContain('/help — List built-in slash commands');
    expect(screen).toContain('/reload — ');
    expect(screen).toContain('User commands:');
    expect(screen).toContain('/summarize — Summarize stuff');
  });

  it('wins over a user command of the same name, which is reported as shadowed', async () => {
    mounted = await mount({ commands: commandRegistry([{ name: 'help', body: 'Help!' }]) }, tall);
    expect(mounted.screen()).toContain(
      'warning: user command /help is shadowed by the built-in of the same name',
    );
    await mounted.keys('/help\r');

    expect(mounted.screen()).toContain('/help — List built-in slash commands');
    expect(mounted.screen()).not.toContain('unknown command');
    expect(mounted.session.sent).toEqual([]);
  });
});

describe('user commands and skills', () => {
  it('sends a user command expanded with its arguments', async () => {
    const commands = commandRegistry([{ name: 'summarize', body: 'Summarize: $ARGUMENTS' }]);
    mounted = await mount({ commands });
    await mounted.keys('/summarize the current branch\r');

    expect(mounted.session.sent).toEqual(['Summarize: the current branch']);
  });

  it('shows the command as typed, not the expanded message the session echoes', async () => {
    const commands = commandRegistry([{ name: 'summarize', body: 'Summarize: $ARGUMENTS' }]);
    mounted = await mount({ commands });
    await mounted.keys('/summarize the current branch\r');
    await mounted.event(userMessage('Summarize: the current branch'));

    expect(mounted.screen()).toContain('    you  /summarize the current branch');
    expect(mounted.screen()).not.toContain('Summarize: the current branch');
  });

  it('sends a skill invocation with the path of the skill and the arguments', async () => {
    const skills = skillRegistry([
      { name: 'pdf', description: 'PDF things', path: '/abs/.chimera/skills/pdf/SKILL.md' },
    ]);
    mounted = await mount({ commands: commandRegistry([]), skills });
    await mounted.keys('/pdf merge foo.pdf bar.pdf\r');

    expect(mounted.session.sent).toEqual([
      'Use the "pdf" skill from /abs/.chimera/skills/pdf/SKILL.md.\n\nmerge foo.pdf bar.pdf',
    ]);
  });

  it('sends a skill invocation without arguments', async () => {
    const skills = skillRegistry([{ name: 'pdf', description: 'PDF things' }]);
    mounted = await mount({ commands: commandRegistry([]), skills });
    await mounted.keys('/pdf\r');

    expect(mounted.session.sent).toEqual([
      'Use the "pdf" skill from /tmp/.chimera/skills/pdf/SKILL.md.',
    ]);
  });

  it('runs a user command over a skill of the same name', async () => {
    mounted = await mount({
      commands: commandRegistry([{ name: 'pdf', body: 'Command body $ARGUMENTS' }]),
      skills: skillRegistry([{ name: 'pdf', description: 'PDF things' }]),
    });
    await mounted.keys('/pdf hello\r');

    expect(mounted.session.sent).toEqual(['Command body hello']);
  });

  it('suggests the closest name for an unknown command and sends nothing', async () => {
    mounted = await mount({ commands: commandRegistry([{ name: 'summarize', body: 'S' }]) });
    await mounted.keys('/summarze foo\r');

    expect(mounted.screen()).toContain(
      '✗ error  unknown command: /summarze — did you mean /summarize?',
    );
    expect(mounted.session.sent).toEqual([]);
  });
});

describe('/reload', () => {
  it('reloads the commands and says how many there are', async () => {
    let commands = [{ name: 'before', body: 'b' }];
    const listeners = new Set<() => void>();
    const entry = (command: { name: string; body: string }) => ({
      ...command,
      path: `/tmp/${command.name}.md`,
      source: 'project' as const,
    });
    const reloading: CommandRegistry = {
      list: () => commands.map(entry),
      find: (name) => {
        const found = commands.find((command) => command.name === name);
        return found ? entry(found) : undefined;
      },
      expand: () => '',
      collisions: () => [],
      reload: async () => {
        commands = [...commands, { name: 'after', body: 'a' }];
        for (const listener of listeners) listener();
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    mounted = await mount({ commands: reloading });
    await mounted.keys('/reload\r');

    expect(mounted.screen()).toContain('   note  commands reloaded (2 total)');
    expect(mounted.screen()).toContain('   note  commands reloaded.');
  });
});

describe('/model', () => {
  it('shows the current model without an argument', async () => {
    mounted = await mount();
    await mounted.keys('/model\r');

    expect(mounted.screen()).toContain('   note  current model: manticore/gpt');
  });

  it('sets the model of the session', async () => {
    const models: Array<string | null> = [];
    const { mounted } = await mountWith({
      setModel: async (_sessionId: string, modelRef: string | null) => {
        models.push(modelRef);
      },
    });
    await mounted.keys('/model other/new\r');

    expect(models).toEqual(['other/new']);
    expect(mounted.screen()).toContain('   note  model set to other/new');
  });

  it('clears the override with "default"', async () => {
    const models: Array<string | null> = [];
    const { mounted } = await mountWith({
      setModel: async (_sessionId: string, modelRef: string | null) => {
        models.push(modelRef);
      },
    });
    await mounted.keys('/model default\r');

    expect(models).toEqual([null]);
    expect(mounted.screen()).toContain('   note  model override cleared');
  });
});

describe('overlay commands', () => {
  function overlay(
    diff = { added: [] as string[], modified: [] as string[], deleted: [] as string[] },
  ) {
    const calls = { diff: 0, discard: 0 };
    return {
      calls,
      handlers: {
        diff: async () => {
          calls.diff += 1;
          return diff;
        },
        apply: async () => {},
        discard: async () => {
          calls.discard += 1;
        },
      },
    };
  }

  it('/overlay lists the pending changes', async () => {
    const { calls, handlers } = overlay({
      added: ['new.ts'],
      modified: ['changed.ts'],
      deleted: ['gone.ts'],
    });
    mounted = await mount({ sandboxMode: 'overlay', overlay: handlers });
    await mounted.keys('/overlay\r');
    const screen = mounted.screen();

    expect(calls.diff).toBe(1);
    expect(screen).toContain('   note  overlay diff (3):');
    expect(screen).toMatch(/^ +\+ new\.ts$/m);
    expect(screen).toMatch(/^ +~ changed\.ts$/m);
    expect(screen).toMatch(/^ +- gone\.ts$/m);
  });

  it('/overlay says when there are no pending changes', async () => {
    mounted = await mount({ sandboxMode: 'overlay', overlay: overlay().handlers });
    await mounted.keys('/overlay\r');

    expect(mounted.screen()).toContain('   note  overlay: no pending changes');
  });

  it('/discard discards the overlay once', async () => {
    const { calls, handlers } = overlay();
    mounted = await mount({ sandboxMode: 'overlay', overlay: handlers });
    await mounted.keys('/discard\r');

    expect(calls.discard).toBe(1);
    expect(mounted.screen()).toContain('   note  overlay discarded');
  });
});

describe('subagents', () => {
  const subagent = (over: Partial<Record<string, string>> = {}) => ({
    subagentId: 'sub-aaaaaaaaaa-bbbbbbbbbb',
    sessionId: 'child-sess',
    url: 'http://127.0.0.1:9999',
    purpose: 'investigate logs',
    status: 'running',
    ...over,
  });

  it('/subagents says when there are none', async () => {
    mounted = await mount();
    await mounted.keys('/subagents\r');

    expect(mounted.screen()).toContain('   note  no active subagents');
  });

  it('/subagents lists each one with its id, purpose, status and url', async () => {
    const { mounted } = await mountWith({ listSubagents: async () => [subagent()] });
    await mounted.keys('/subagents\r');

    expect(mounted.screen()).toContain('   note  subagents:');
    expect(mounted.screen()).toContain(
      'sub-aaaaaaaaaa-bbbbbbbbbb  investigate logs  running  http://127.0.0.1:9999',
    );
  });

  it('/attach without an id shows the usage', async () => {
    mounted = await mount();
    await mounted.keys('/attach\r');

    expect(mounted.screen()).toContain('   note  usage: /attach <subagentId>');
  });

  it('/attach rejects an unknown id', async () => {
    mounted = await mount();
    await mounted.keys('/attach nothere\r');

    expect(mounted.screen()).toContain('✗ error  /attach: no subagent matching "nothere"');
  });

  it('/attach rejects a subagent that runs in-process', async () => {
    const { mounted } = await mountWith({
      listSubagents: async () => [subagent({ subagentId: 'sub-inproc', url: '' })],
    });
    await mounted.keys('/attach sub-inproc\r');

    expect(mounted.screen()).toContain(
      '✗ error  /attach: subagent sub-inproc is in-process and not attachable',
    );
  });

  it('/attach finds a subagent by the end of its id and attaches to it', async () => {
    // Nothing listens on port 1, so the child's event stream fails at once.
    const { mounted } = await mountWith({
      listSubagents: async () => [
        subagent({
          subagentId: 'sub-prefix-tail-1234',
          purpose: 'sandbox child',
          url: 'http://127.0.0.1:1',
        }),
      ],
    });
    await mounted.keys('/attach tail-1234\r');

    expect(mounted.screen()).toContain(
      '   note  attaching to subagent sub-prefix-tail-1234 (sandbox child) at http://127.0.0.1:1',
    );
  });

  it('/detach does nothing on the parent session', async () => {
    mounted = await mount();
    await mounted.keys('/detach\r');

    expect(mounted.screen()).toContain('   note  already attached to the parent session');
  });
});

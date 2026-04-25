import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChimeraClient } from '@chimera/client';
import { InMemoryCommandRegistry, type CommandRegistry } from '@chimera/commands';
import type { AgentEvent } from '@chimera/core';
import { InMemorySkillRegistry, type SkillRegistry } from '@chimera/skills';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';

interface SubagentStub {
  subagentId: string;
  sessionId: string;
  url: string;
  purpose: string;
  status: 'running' | 'finished';
}

interface StubClientOpts {
  sendSpy?: (msg: string) => void;
  /**
   * When the TUI calls `send(id, content)`, the stub will emit these events
   * via its subscribe() stream — simulating the real server echoing a
   * user_message (and optionally more) after it processes the POST.
   */
  echoOnSend?: (content: string) => AgentEvent[];
  /** Active subagents returned by `listSubagents`. */
  subagents?: SubagentStub[];
}

function stubClient(opts: StubClientOpts = {}): ChimeraClient {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | null = null;

  return {
    subscribe: async function* () {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
    send: async function* (_id: string, msg: string) {
      opts.sendSpy?.(msg);
      for (const ev of opts.echoOnSend?.(msg) ?? []) {
        queue.push(ev);
      }
      wake?.();
      wake = null;
    },
    interrupt: async () => {},
    listRules: async () => [],
    addRule: async () => {},
    removeRule: async () => {},
    resolvePermission: async () => {},
    listSubagents: async () => opts.subagents ?? [],
  } as unknown as ChimeraClient;
}

function registry(
  cmds: { name: string; body: string; description?: string }[],
): CommandRegistry {
  return new InMemoryCommandRegistry(
    cmds.map((c) => ({
      name: c.name,
      body: c.body,
      description: c.description,
      path: `/tmp/${c.name}.md`,
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
    skills.map((s) => ({
      name: s.name,
      description: s.description,
      path: s.path ?? `/tmp/.chimera/skills/${s.name}/SKILL.md`,
      source: 'project' as const,
      frontmatter: {},
    })),
    [],
  );
}

async function type(stdin: NodeJS.WritableStream, text: string): Promise<void> {
  for (const ch of text) {
    (stdin as any).write(ch);
    await new Promise((r) => setTimeout(r, 1));
  }
  await new Promise((r) => setTimeout(r, 20));
}

describe('TUI slash dispatch', () => {
  it('/help lists user commands with descriptions', async () => {
    const reg = registry([
      { name: 'summarize', body: 'Summarize $ARGUMENTS', description: 'Summarize stuff' },
    ]);
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/help\r');
    const frame = lastFrame()!;
    expect(frame).toContain('/help');
    expect(frame).toContain('User commands');
    expect(frame).toContain('/summarize');
    expect(frame).toContain('Summarize stuff');
    unmount();
  });

  it('built-in wins over a user template with the same name', async () => {
    const reg = registry([{ name: 'help', body: 'Help template!' }]);
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/help\r');
    const frame = lastFrame()!;
    // The built-in /help lists commands — shouldn't have fired an "unknown" error.
    expect(frame).not.toContain('unknown command');
    // Warning about shadowed user template should have been logged once.
    expect(frame).toContain('shadowed by the built-in');
    // The template body should NOT have been sent as a user message.
    expect(sent).toEqual([]);
    unmount();
  });

  it('user template dispatches and sends expanded message', async () => {
    const reg = registry([
      { name: 'summarize', body: 'Summarize: $ARGUMENTS' },
    ]);
    const sent: string[] = [];
    const { stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/summarize the current branch\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(['Summarize: the current branch']);
    unmount();
  });

  it('shows the raw /<name> invocation in scrollback and suppresses the echoed expanded body', async () => {
    const reg = registry([
      { name: 'summarize', body: 'Summarize: $ARGUMENTS' },
    ]);
    const sent: string[] = [];
    // Simulate the server echoing a user_message event with the expanded text
    // (which is what the real server does after POST /messages).
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({
          sendSpy: (m) => sent.push(m),
          echoOnSend: (content) => [{ type: 'user_message', content }],
        })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/summarize the current branch\r');
    await new Promise((r) => setTimeout(r, 30));
    const frame = lastFrame()!;
    // The invocation the user typed appears.
    expect(frame).toContain('/summarize the current branch');
    // The expanded body is sent to the server...
    expect(sent).toEqual(['Summarize: the current branch']);
    // ...but is NOT shown in the scrollback (suppression consumed the echo).
    expect(frame).not.toContain('Summarize: the current branch');
    unmount();
  });

  it('/reload calls registry.reload() and logs on change', async () => {
    // Hand-built reloadable registry. `reload()` bumps an internal list and
    // notifies subscribers — simulating the real ReloadingCommandRegistry.
    let items: { name: string; body: string; description?: string }[] = [
      { name: 'before', body: 'b' },
    ];
    const listeners = new Set<() => void>();
    const reg: CommandRegistry = {
      list: () =>
        items.map((c) => ({
          name: c.name,
          body: c.body,
          description: c.description,
          path: `/tmp/${c.name}.md`,
          source: 'project' as const,
        })),
      find: (name) => {
        const c = items.find((x) => x.name === name);
        return c
          ? {
              name: c.name,
              body: c.body,
              description: c.description,
              path: `/tmp/${c.name}.md`,
              source: 'project' as const,
            }
          : undefined;
      },
      expand: () => '',
      collisions: () => [],
      reload: async () => {
        items = [...items, { name: 'after', body: 'a' }];
        for (const l of listeners) l();
      },
      onChange: (l) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
    };

    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/reload\r');
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame()!;
    expect(frame).toContain('commands reloaded (2 total)');
    unmount();
  });

  it('/help lists /reload as a built-in', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={registry([])}
      />,
    );
    await type(stdin, '/help\r');
    expect(lastFrame()!).toContain('/reload');
    unmount();
  });

  it('/<skill> with args dispatches as a synthesized user message', async () => {
    const skills = skillRegistry([
      {
        name: 'pdf',
        description: 'PDF things',
        path: '/abs/.chimera/skills/pdf/SKILL.md',
      },
    ]);
    const sent: string[] = [];
    const { stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={registry([])}
        skills={skills}
      />,
    );
    await type(stdin, '/pdf merge foo.pdf bar.pdf\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Use the "pdf" skill');
    expect(sent[0]).toContain('/abs/.chimera/skills/pdf/SKILL.md');
    expect(sent[0]).toContain('merge foo.pdf bar.pdf');
    unmount();
  });

  it('/<skill> with no args still dispatches (no appended body)', async () => {
    const skills = skillRegistry([
      { name: 'pdf', description: 'PDF things' },
    ]);
    const sent: string[] = [];
    const { stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={registry([])}
        skills={skills}
      />,
    );
    await type(stdin, '/pdf\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Use the "pdf" skill');
  });

  it('user command shadows a skill of the same name', async () => {
    const reg = registry([{ name: 'pdf', body: 'Command body $ARGUMENTS' }]);
    const skills = skillRegistry([{ name: 'pdf', description: 'PDF things' }]);
    const sent: string[] = [];
    const { stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
        skills={skills}
      />,
    );
    await type(stdin, '/pdf hello\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual(['Command body hello']);
    unmount();
  });

  it('unknown /<name> shows a fuzzy hint and does not send a message', async () => {
    const reg = registry([{ name: 'summarize', body: 'S $ARGUMENTS' }]);
    const sent: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ sendSpy: (m) => sent.push(m) })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        commands={reg}
      />,
    );
    await type(stdin, '/summarze foo\r');
    const frame = lastFrame()!;
    expect(frame).toContain('unknown command');
    expect(frame).toContain('did you mean');
    expect(frame).toContain('/summarize');
    expect(sent).toEqual([]);
    unmount();
  });
});

describe('TUI overlay slash dispatch', () => {
  it('/overlay lists pending changes from overlay.diff()', async () => {
    let diffCalls = 0;
    const overlay = {
      diff: async () => {
        diffCalls += 1;
        return { added: ['new.ts'], modified: ['changed.ts'], deleted: ['gone.ts'] };
      },
      apply: async () => {},
      discard: async () => {},
    };
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        sandboxMode="overlay"
        overlay={overlay}
      />,
    );
    await type(stdin, '/overlay\r');
    const frame = lastFrame()!;
    expect(diffCalls).toBe(1);
    expect(frame).toContain('+ new.ts');
    expect(frame).toContain('~ changed.ts');
    expect(frame).toContain('- gone.ts');
    unmount();
  });

  it('/overlay reports "no pending changes" when the diff is empty', async () => {
    const overlay = {
      diff: async () => ({ added: [], modified: [], deleted: [] }),
      apply: async () => {},
      discard: async () => {},
    };
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        sandboxMode="overlay"
        overlay={overlay}
      />,
    );
    await type(stdin, '/overlay\r');
    expect(lastFrame()).toContain('no pending changes');
    unmount();
  });

  it('/discard calls overlay.discard() once', async () => {
    let discardCalls = 0;
    const overlay = {
      diff: async () => ({ added: [], modified: [], deleted: [] }),
      apply: async () => {},
      discard: async () => {
        discardCalls += 1;
      },
    };
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({})}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
        sandboxMode="overlay"
        overlay={overlay}
      />,
    );
    await type(stdin, '/discard\r');
    expect(discardCalls).toBe(1);
    expect(lastFrame()).toContain('overlay discarded');
    unmount();
  });

});

// /theme reads/writes ~/.chimera/{theme.json,themes/}, so we redirect HOME to
// a tempdir for the duration of each test rather than touching the user's real
// state. os.homedir() honours $HOME on POSIX, which is enough for these tests.
describe('TUI /theme slash dispatch', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chimera-tui-theme-'));
    mkdirSync(join(tmpHome, '.chimera'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('lists bundled presets when no theme is active', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/theme\r');
    const frame = lastFrame()!;
    expect(frame).toContain('themes:');
    expect(frame).toContain('cyberpunk');
    expect(frame).toContain('tokyo-night-moon');
    expect(frame).toContain('default');
    expect(frame).toContain('Use /theme <name> to apply.');
    unmount();
  });

  it('marks the active theme with a leading * after /theme <name>', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/theme cyberpunk\r');
    await type(stdin, '/theme\r');
    const frame = lastFrame()!;
    expect(frame).toMatch(/\*\s+cyberpunk/);
    unmount();
  });

  it('applying a builtin writes theme.json with a _themeName marker and confirms in scrollback', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/theme cyberpunk\r');
    expect(lastFrame()).toContain("theme: applied 'cyberpunk' (builtin)");
    const written = JSON.parse(
      readFileSync(join(tmpHome, '.chimera', 'theme.json'), 'utf-8'),
    );
    expect(written._themeName).toBe('cyberpunk');
    expect(written.accent.primary).toBeDefined();
    unmount();
  });

  it('reports an error for an unknown theme name', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/theme not-a-real-theme\r');
    const frame = lastFrame()!;
    expect(frame).toMatch(/\/theme:.*unknown theme/);
    expect(frame).toContain('not-a-real-theme');
    unmount();
  });

  it('user-dir presets shadow builtins of the same name in the listing', async () => {
    const themesDir = join(tmpHome, '.chimera', 'themes');
    mkdirSync(themesDir, { recursive: true });
    writeFileSync(join(themesDir, 'cyberpunk.json'), '{}');
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/theme\r');
    const frame = lastFrame()!;
    // The shadowed cyberpunk entry shows the (user) tag.
    expect(frame).toMatch(/cyberpunk\s+\(user\)/);
    unmount();
  });

  it('/subagents reports an empty list when no children are active', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/subagents\r');
    expect(lastFrame()!).toContain('no active subagents');
    unmount();
  });

  it('/subagents lists active children with id, purpose, status, and url', async () => {
    const sub: SubagentStub = {
      subagentId: 'sub-aaaaaaaaaa-bbbbbbbbbb',
      sessionId: 'child-sess',
      url: 'http://127.0.0.1:9999',
      purpose: 'investigate logs',
      status: 'running',
    };
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ subagents: [sub] })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, '/subagents\r');
    const frame = lastFrame()!;
    expect(frame).toContain(sub.subagentId);
    expect(frame).toContain(sub.purpose);
    expect(frame).toContain('running');
    expect(frame).toContain(sub.url);
    unmount();
  });

  it('/attach with no argument prints usage', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/attach\r');
    expect(lastFrame()!).toContain('usage: /attach <subagentId>');
    unmount();
  });

  it('/attach rejects an unknown subagent id', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({ subagents: [] })} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/attach nothere\r');
    expect(lastFrame()!).toMatch(/no subagent matching "nothere"/);
    unmount();
  });

  it('/attach rejects in-process subagents (empty url)', async () => {
    const sub: SubagentStub = {
      subagentId: 'sub-inproc',
      sessionId: 'child-sess',
      url: '',
      purpose: 'parallel research',
      status: 'running',
    };
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ subagents: [sub] })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, '/attach sub-inproc\r');
    expect(lastFrame()!).toMatch(/in-process and not attachable/);
    unmount();
  });

  it('/attach matches by trailing-id substring and reports the swap', async () => {
    const sub: SubagentStub = {
      subagentId: 'sub-prefix-tail-1234',
      sessionId: 'child-sess',
      // Point at a port that won't accept connections so the swapped subscribe
      // fails fast — we only assert the dispatch line, not the live stream.
      url: 'http://127.0.0.1:1',
      purpose: 'sandbox child',
      status: 'running',
    };
    const { lastFrame, stdin, unmount } = render(
      <App
        client={stubClient({ subagents: [sub] })}
        sessionId="s"
        modelRef="m/m"
        cwd="/tmp"
      />,
    );
    await type(stdin, '/attach tail-1234\r');
    expect(lastFrame()!).toContain(`attaching to subagent ${sub.subagentId}`);
    unmount();
  });

  it('/detach is a no-op when already on the parent session', async () => {
    const { lastFrame, stdin, unmount } = render(
      <App client={stubClient({})} sessionId="s" modelRef="m/m" cwd="/tmp" />,
    );
    await type(stdin, '/detach\r');
    expect(lastFrame()!).toContain('already attached to the parent session');
    unmount();
  });
});

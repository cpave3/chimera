import type { AgentEvent } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import type { AppProps } from '../src/App';
import { fakeSession, mountFullscreen, plain, settle, usage } from './fullscreen-helpers';

/** The panel's rows: what is right of the transcript column. */
async function panel(
  overrides: Partial<AppProps>,
  events: AgentEvent[] = [],
  session = fakeSession(),
): Promise<string> {
  const { lastFrame, unmount } = mountFullscreen(overrides, session);
  for (const event of events) session.push(event);
  await settle(600);
  const rows = plain(lastFrame()).split('\n');
  unmount();
  // 100 columns: the panel takes the last 32.
  return rows.map((row) => row.slice(68).trimEnd()).join('\n');
}

const registry = (count: number, extra: object = {}) =>
  ({
    all: () => Array.from({ length: count }, (_, index) => ({ name: `item${index}` })),
    list: () => Array.from({ length: count }, (_, index) => ({ name: `item${index}` })),
    collisions: () => [],
    buildIndex: () => '',
    ...extra,
  }) as never;

describe('context panel', () => {
  it('names the model, the session, the sandbox and what was loaded', async () => {
    const text = await panel({ skills: registry(60), commands: registry(9), sandboxMode: 'off' });

    expect(text).toContain('◆ chimera v0.1.0');
    expect(text).toMatch(/model +manticore\/gpt/);
    expect(text).toMatch(/session +8AWWBRGC/);
    expect(text).toMatch(/sandbox +off/);
    expect(text).toMatch(/loaded +60 skills · 9 cmds/);
  });

  it('says that host commands run in the OS sandbox, and leaves a Docker sandbox its own name', async () => {
    expect(await panel({ sandboxMode: 'off', osSandbox: true })).toMatch(/sandbox +os/);
    expect(await panel({ sandboxMode: 'bind', osSandbox: true })).toMatch(/sandbox +bind/);
  });

  it('says the same in the inline layout, which has no panel', async () => {
    const { lastFrame, unmount } = mountFullscreen({ layout: 'inline', osSandbox: true });
    await settle(100);
    const frame = plain(lastFrame());
    unmount();

    expect(frame).toContain('mode build · sandbox os');
    expect(frame).not.toContain('sandbox off');
  });

  it('shows how full the context is', async () => {
    const text = await panel({}, [usage(76_000)]);

    expect(text).toMatch(/CONTEXT · 76k \/ 200k +38%/);
    expect(text).not.toContain('■ system');
  });

  it('splits the context bar when the size of the system prompt is known', async () => {
    const text = await panel(
      { skills: registry(60, { buildIndex: () => 'x'.repeat(88_000) }) },
      [usage(76_000)],
      fakeSession({ breakdown: { systemPromptTokens: 38_000 } }),
    );

    expect(text).toContain('■ system ■ skills ■ history');
  });

  it('shows the plan with the state of each task', async () => {
    const text = await panel({}, [
      {
        type: 'task_list_updated',
        tasks: [
          { content: 'locate list command', status: 'completed' },
          { content: 'add --json option', status: 'completed' },
          { content: 'snapshot test', status: 'in_progress' },
          { content: 'update README usage', status: 'pending' },
        ],
      } as AgentEvent,
    ]);

    expect(text).toContain('PLAN · 2/4');
    expect(text).toContain('✓ locate list command');
    expect(text).toContain('▸ snapshot test');
    expect(text).toContain('○ update README usage');
  });

  it('shows the branch and the changed files of the working tree', async () => {
    const text = await panel({
      readWorktree: async () => ({
        branch: 'yg/json-flag',
        ahead: 1,
        behind: 0,
        files: [
          { path: 'src/yg/commands/list.ts', status: 'M', added: 18, removed: 3 },
          { path: 'src/yg/commands/list.test.ts', status: 'A' },
        ],
      }),
    });

    expect(text).toContain('WORKTREE');
    expect(text).toMatch(/yg\/json-flag +↑1/);
    expect(text).toMatch(/M list\.ts +\+18 −3/);
    expect(text).toContain('A list.test.ts');
  });

  it('tells two changed files of the same name apart by their directory', async () => {
    const text = await panel({
      readWorktree: async () => ({
        branch: 'main',
        ahead: 0,
        behind: 0,
        files: [
          { path: 'packages/tui/src/index.ts', status: 'M', added: 1, removed: 0 },
          { path: 'packages/cli/src/index.ts', status: 'M', added: 2, removed: 0 },
        ],
      }),
    });

    expect(text).toContain('M tui/src/index.ts');
    expect(text).toContain('M cli/src/index.ts');
  });

  it('names an untracked directory', async () => {
    const text = await panel({
      readWorktree: async () => ({
        branch: 'main',
        ahead: 0,
        behind: 0,
        files: [{ path: 'packages/new/', status: 'A' }],
      }),
    });

    expect(text).toContain('A new/');
  });

  it('leaves the working tree out when the directory is not a repository', async () => {
    const text = await panel({ readWorktree: async () => null });
    expect(text).not.toContain('WORKTREE');
  });

  it('lists the other live instances with what each is doing', async () => {
    const text = await panel({
      listPeers: async () => [
        { label: 'chimera-2', mode: 'plan', status: 'idle' },
        { label: 'api', mode: 'build', status: 'waiting_for_permission' },
      ],
    });

    expect(text).toContain('PEERS');
    expect(text).toMatch(/● chimera-2 +plan · idle/);
    expect(text).toMatch(/● api +build · approval/);
  });

  it('shows the token total of the session at the bottom, with in and out side by side under it', async () => {
    const text = await panel({}, [usage(76_000)]);
    const lines = text.trimEnd().split('\n');

    expect(lines.at(-2)).toMatch(/^ *total +3\.8k$/);
    expect(lines.at(-1)).toMatch(/^ *in +3\.2k +out +640$/);
    // Half of the panel each: "out" starts at the middle of the row.
    const row = lines.at(-1)!;
    const start = row.search(/\S/);
    const middle = start + Math.floor((row.length - start) / 2);
    expect(Math.abs(row.indexOf('out') - middle)).toBeLessThanOrEqual(1);
  });

  it('adds the cached share of the last step under them when there is one', async () => {
    const cachedUsage = usage(76_000) as Extract<AgentEvent, { type: 'usage_updated' }>;
    cachedUsage.usage.lastStep = {
      inputTokens: 76_000,
      outputTokens: 640,
      cachedInputTokens: 60_800,
    };

    const lines = (await panel({}, [cachedUsage])).trimEnd().split('\n');

    expect(lines.at(-3)).toMatch(/^ *total +3\.8k$/);
    expect(lines.at(-2)).toMatch(/^ *in +3\.2k +out +640$/);
    expect(lines.at(-1)).toMatch(/^ *cache +80%$/);
  });
});

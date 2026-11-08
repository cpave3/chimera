import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, runFinished, settle, text, toolCall, userMessage } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const event = (value: unknown) => value as AgentEvent;

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const subagentEvent = (subagentId: string, inner: unknown) =>
  event({ type: 'subagent_event', subagentId, event: inner });

function childRead(subagentId: string, callId: string, path: string, summary: string) {
  return [
    subagentEvent(subagentId, {
      type: 'tool_call_start',
      callId,
      name: 'read',
      args: { path },
      target: 'sandbox',
      display: { summary: path },
    }),
    subagentEvent(subagentId, {
      type: 'tool_call_result',
      callId,
      result: { content: 'x', total_lines: 1, truncated: false },
      durationMs: 1,
      display: { summary },
    }),
  ];
}

function spawnFinished(subagentId: string, parentCallId: string, summary: string, done: string) {
  return [
    subagentEvent(subagentId, { type: 'assistant_text_done', text: summary }),
    event({ type: 'subagent_finished', subagentId, parentCallId, result: summary, reason: 'stop' }),
    event({
      type: 'tool_call_result',
      callId: parentCallId,
      result: { result: summary, reason: 'stop' },
      durationMs: 5,
      display: { summary: done },
    }),
  ];
}

describe('the frame around the transcript', () => {
  it('names the version, model and working directory in the banner', async () => {
    mounted = await mount({ modelRef: 'anthropic/claude-opus-4-7', cwd: '/tmp/proj' });

    expect(mounted.term.screen()[0]).toBe(
      'chimera  v9.9.9 · anthropic/claude-opus-4-7 · /tmp/proj',
    );
  });

  it('points to the help card instead of listing the keys', async () => {
    mounted = await mount();

    expect(mounted.screen()).toContain('? help');
    expect(mounted.screen()).not.toContain('Ctrl+Z');
    expect(mounted.screen()).toMatch(/^│ › +│$/m);
  });
});

describe('transcript rows', () => {
  it('labels a message of the user "you"', async () => {
    mounted = await mount();
    await mounted.event(userMessage('fix the test'));

    expect(mounted.screen()).toContain('    you  fix the test');
    expect(mounted.screen()).not.toContain('you:');
  });

  it('shows neither the encoded SDK name of an MCP tool nor its argument values', async () => {
    mounted = await mount();
    await mounted.event(
      event({
        type: 'tool_call_start',
        callId: 'mcp-1',
        name: 'mcp_burnlite_add_x00005f_task_x00005f_to_x00005f_project',
        args: { project_id: 'private-value' },
        target: 'host',
        display: { label: 'burnlite / add_task_to_project', summary: 'project_id' },
      }),
    );

    expect(mounted.screen()).toContain('  add_task_to_project project_id');
    expect(mounted.screen()).not.toContain('x00005f');
    expect(mounted.screen()).not.toContain('private-value');
  });

  it('gives a tool call no target badge when no sandbox is active', async () => {
    mounted = await mount({ sandboxMode: 'off' });
    await mounted.event(
      ...toolCall('c1', 'bash', { command: 'echo hi' }, 'echo hi', {
        stdout: '',
        stderr: '',
        exit_code: 0,
      }),
    );

    expect(mounted.screen()).toContain('   bash  echo hi  1.2s');
    expect(mounted.screen()).not.toContain('[host]');
  });

  it.each([
    'sandbox',
    'host',
  ] as const)('says where a %s tool call runs when a sandbox is active', async (target) => {
    mounted = await mount({ sandboxMode: 'bind' });
    const [start, result] = toolCall('c1', 'bash', { command: 'echo hi' }, 'echo hi', {
      stdout: '',
      stderr: '',
      exit_code: 0,
    });
    await mounted.event(event({ ...start, target }), result!);

    expect(mounted.screen()).toContain(`   bash  [${target}] echo hi  1.2s`);
  });

  it('draws each tool call once when the results arrive out of order', async () => {
    mounted = await mount({ layout: 'inline' });
    await mounted.event(
      text('running two tools'),
      event({ type: 'assistant_text_done', id: 't1', text: 'running two tools' }),
      ...toolCall('a', 'bash', {}, 'TOOL_ALPHA_SUMMARY'),
      ...toolCall('b', 'read', {}, 'TOOL_BETA_SUMMARY'),
    );
    await mounted.event(
      event({
        type: 'tool_call_result',
        callId: 'b',
        result: {},
        durationMs: 1,
        display: { summary: 'TOOL_BETA_SUMMARY' },
      }),
    );
    await mounted.event(
      event({
        type: 'tool_call_result',
        callId: 'a',
        result: {},
        durationMs: 1,
        display: { summary: 'TOOL_ALPHA_SUMMARY' },
      }),
      runFinished,
    );
    const history = mounted.term.history().join('\n');

    expect(count(history, 'TOOL_ALPHA_SUMMARY')).toBe(1);
    expect(count(history, 'TOOL_BETA_SUMMARY')).toBe(1);
    expect(count(history, 'running two tools')).toBe(1);
  });
});

describe('notices', () => {
  it('says when a background process exits', async () => {
    mounted = await mount();
    await mounted.event(
      event({
        type: 'background_process_exited',
        shellId: 'shell_1',
        command: 'pnpm dev',
        status: 'exited',
        exitCode: 1,
      }),
    );

    expect(mounted.screen()).toContain(
      '   note  background process shell_1 exited (exit 1): pnpm dev',
    );
  });

  it('shows the assistance the agent asks for without error language', async () => {
    mounted = await mount();
    await mounted.event(
      event({ type: 'user_input_required', request: 'Run X and paste the output', kind: 'action' }),
      event({ type: 'run_finished', reason: 'waiting_for_input' }),
    );
    const screen = mounted.screen();

    expect(screen).toContain('   note  Waiting for input: Run X and paste the output');
    expect(screen).not.toContain('✗ error');
    expect(screen).not.toContain('interrupted');
  });
});

describe('vision routing', () => {
  it('announces the route and names the vision model in the status line', async () => {
    mounted = await mount();
    await mounted.event(
      event({ type: 'vision_route_started', from: 'text/m', to: 'vis/v', trigger: 'user_images' }),
    );

    expect(mounted.screen()).toContain('   note  vision: routing this turn to vis/v');
    expect(mounted.term.screen().at(-2)).toMatch(/^╰─ manticore\/gpt → vis\/v \(vision\) ─/);
  });

  it('announces the way back and drops the vision model when the turn ends', async () => {
    mounted = await mount();
    await mounted.event(
      event({ type: 'vision_route_started', from: 'text/m', to: 'vis/v', trigger: 'tool_image' }),
      event({ type: 'vision_route_ended', restored: 'text/m' }),
    );

    expect(mounted.screen()).toContain('   note  vision: turn finished, back on text/m');
    expect(mounted.screen()).not.toContain('(vision)');
  });

  it('reports an unavailable route as an error', async () => {
    mounted = await mount();
    await mounted.event(
      event({ type: 'vision_route_unavailable', reason: 'defaultVisionModel is not set' }),
    );

    expect(mounted.screen()).toContain('✗ error  vision: defaultVisionModel is not set');
  });
});

describe('compaction', () => {
  it('shows it running in the prompt box, then its result', async () => {
    mounted = await mount();
    await mounted.event(event({ type: 'compaction_started', reason: 'manual' }));
    expect(mounted.term.screen().at(-4)).toContain('compacting');

    await mounted.event(
      event({
        type: 'compaction_finished',
        summary: 'synthetic',
        tokensBefore: 1000,
        tokensAfter: 200,
        messagesReplaced: 5,
      }),
    );

    expect(mounted.term.screen().at(-4)).not.toContain('compacting');
    expect(mounted.term.screen().at(-4)).toContain('? help');
    expect(mounted.screen()).toContain(
      'compact  compaction done: -800 tokens (5 messages replaced)',
    );
  });

  it('reports a failed compaction as an error', async () => {
    mounted = await mount();
    await mounted.event(event({ type: 'compaction_started', reason: 'threshold' }));
    expect(mounted.term.screen().at(-4)).toContain('compacting');

    await mounted.event(event({ type: 'compaction_failed', error: 'model refused' }));

    expect(mounted.term.screen().at(-4)).not.toContain('compacting');
    expect(mounted.screen()).toContain('✗ error  compaction failed: model refused');
  });
});

describe('the task row', () => {
  it('counts the finished tasks while the run goes', async () => {
    mounted = await mount();
    await mounted.keys('go\r');
    await mounted.event(
      userMessage('go'),
      event({
        type: 'task_list_updated',
        tasks: [
          { content: 'write failing test', status: 'completed' },
          { content: 'implement feature', status: 'in_progress' },
          { content: 'refactor', status: 'pending' },
        ],
      }),
    );
    expect(mounted.screen()).toContain('  tasks  1/3 ✓ ▸ implement feature ○');

    await mounted.event(
      event({
        type: 'task_list_updated',
        tasks: [
          { content: 'write failing test', status: 'completed' },
          { content: 'implement feature', status: 'completed' },
          { content: 'refactor', status: 'completed' },
        ],
      }),
    );

    expect(mounted.screen()).toContain('  tasks  3/3 ✓ ✓ ✓');
  });
});

describe('subagent rows', () => {
  it('keeps the tool rows of a subagent under its spawn once the spawn is done', async () => {
    mounted = await mount({ layout: 'inline' });
    await mounted.event(
      event({
        type: 'tool_call_start',
        callId: 'pc1',
        name: 'spawn_agent',
        args: { prompt: 'investigate', purpose: 'investigate' },
        target: 'host',
        display: { summary: 'investigate' },
      }),
      event({
        type: 'subagent_spawned',
        subagentId: 'sa1',
        parentCallId: 'pc1',
        childSessionId: 'cs',
        url: '',
        purpose: 'investigate',
      }),
      ...childRead('sa1', 'cc1', 'a.ts', 'a.ts (1 lines)'),
      subagentEvent('sa1', {
        type: 'tool_call_start',
        callId: 'cc2',
        name: 'grep',
        args: { pattern: 'foo' },
        target: 'sandbox',
        display: { summary: 'pattern foo' },
      }),
      subagentEvent('sa1', {
        type: 'tool_call_result',
        callId: 'cc2',
        result: { matches: [] },
        durationMs: 1,
        display: { summary: '0 matches' },
      }),
      ...spawnFinished('sa1', 'pc1', 'final summary text', 'investigate (done)'),
    );
    const history = mounted.term.history().join('\n');

    expect(history).toContain('  agent  investigate  done');
    expect(history).toMatch(/[├└] read: a\.ts/);
    expect(history).toMatch(/[├└] grep: 0 matches/);
    expect(history).toContain('final summary text');
  });

  it('keeps the rows of two parallel subagents under their own spawns, late ones too', async () => {
    mounted = await mount({ layout: 'inline' }, { columns: 100, rows: 60 });
    const spawn = (callId: string, purpose: string, subagentId: string) => [
      event({
        type: 'tool_call_start',
        callId,
        name: 'spawn_agent',
        args: { purpose },
        target: 'host',
        display: { summary: purpose },
      }),
      event({
        type: 'subagent_spawned',
        subagentId,
        parentCallId: callId,
        childSessionId: `cs-${subagentId}`,
        url: '',
        purpose,
      }),
    ];
    const lateGreps = [3, 4, 5].flatMap((index) => [
      subagentEvent('saB', {
        type: 'tool_call_start',
        callId: `saB-cc${index}`,
        name: 'grep',
        args: { pattern: `late${index}` },
        target: 'sandbox',
        display: { summary: `late${index}` },
      }),
      subagentEvent('saB', {
        type: 'tool_call_result',
        callId: `saB-cc${index}`,
        result: { matches: [] },
        durationMs: 1,
        display: { summary: `late${index} done` },
      }),
    ]);
    await mounted.event(
      ...spawn('pcA', 'reviewA', 'saA'),
      ...spawn('pcB', 'reviewB', 'saB'),
      ...['saA', 'saB'].flatMap((subagentId) =>
        [0, 1, 2].flatMap((index) =>
          childRead(
            subagentId,
            `${subagentId}-cc${index}`,
            `${subagentId}/${index}.ts`,
            `${subagentId}/${index}.ts (read)`,
          ),
        ),
      ),
      ...spawnFinished('saA', 'pcA', 'A summary', 'reviewA (done)'),
      ...lateGreps,
      ...spawnFinished('saB', 'pcB', 'B summary', 'reviewB (done)'),
    );
    await mounted.keys('\x0f');
    await settle(60);
    const rows = mounted.term.history();
    const spawnB = rows.findIndex((row) => row.includes('agent  reviewB'));
    const underA = rows.slice(0, spawnB).join('\n');
    const underB = rows.slice(spawnB).join('\n');

    expect(spawnB).toBeGreaterThan(0);
    for (const path of ['saA/0.ts', 'saA/1.ts', 'saA/2.ts', 'A summary'])
      expect(underA).toContain(path);
    for (const path of ['saB/0.ts', 'saB/1.ts', 'saB/2.ts', 'late3', 'late4', 'late5', 'B summary'])
      expect(underB).toContain(path);
  });
});

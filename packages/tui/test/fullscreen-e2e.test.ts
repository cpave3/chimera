import type { AgentEvent } from '@chimera/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Mounted, mount, runFinished, settle, text, toolCall, userMessage } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function keyModesOn(term: Mounted['term']): boolean {
  return (
    term.kittyFlags.length > 0 &&
    term.modifyOtherKeys === 1 &&
    term.modes.has(2004) &&
    term.modes.has(1002)
  );
}

describe('the fullscreen layout', () => {
  it('starts on the alternate screen with the banner, an empty prompt box and the status line', async () => {
    mounted = await mount();
    const { term } = mounted;
    expect(term.alternate).toBe(true);
    expect(keyModesOn(term)).toBe(true);
    const rows = term.screen();
    expect(rows[0]).toMatch(/^chimera {2}v9\.9\.9 · manticore\/gpt · \/tmp\/project/);
    expect(rows.at(-4)).toMatch(/^╭─ build ─+ \? help ─╮$/);
    expect(rows.at(-3)).toMatch(/^│ › +│$/);
    expect(rows.at(-2)).toMatch(/^╰─ manticore\/gpt ─+ \/tmp\/project · main ─╯$/);
    expect(rows.at(-1)).toBe('   8AWWBRGC');
  });

  it('draws a full turn: streaming text, tool calls, an edit and a failed bash', async () => {
    mounted = await mount();
    await mounted.keys('fix the bug\r');
    expect(mounted.session.sent).toEqual(['fix the bug']);
    await mounted.event(userMessage('fix the bug'), text('Looking at '));
    expect(mounted.screen()).toMatch(
      /^╭─ build ─+ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 0s · esc interrupt · tab queue ─╮$/m,
    );
    await mounted.event(
      text('the parser.'),
      ...toolCall(
        'c1',
        'read',
        { path: 'src/a.ts' },
        'src/a.ts',
        { kind: 'file' },
        'src/a.ts (10 lines)',
      ),
      ...toolCall(
        'c2',
        'edit',
        { path: 'src/a.ts', old_string: 'a', new_string: 'b\nc' },
        'src/a.ts',
        { startLine: 3 },
        'src/a.ts (1 replacement)',
      ),
      ...toolCall(
        'c3',
        'bash',
        { command: 'pnpm test' },
        'pnpm test',
        { stdout: 'FAIL x', stderr: '', exit_code: 1 },
        'pnpm test (exit 1)',
      ),
      runFinished,
    );
    const screen = mounted.screen();
    expect(screen).toContain('    you  fix the bug');
    expect(screen).toContain('         Looking at the parser.');
    expect(screen).toContain('   read  src/a.ts  10 lines');
    expect(screen).toContain('   edit  src/a.ts  +2 −1');
    expect(screen).toContain(' ✗ bash  pnpm test  exit 1 · 1.2s');
    expect(screen).toContain('         FAIL x');
    expect(screen).toMatch(/\? help ─╮/);
  });

  it('answers a permission card from one key and closes it', async () => {
    mounted = await mount();
    await mounted.event({
      type: 'permission_request',
      requestId: 'p1',
      tool: 'bash',
      target: 'host',
      command: 'git push',
      reason: 'network access',
    } as AgentEvent);
    expect(mounted.screen()).toContain('approval needed');
    expect(mounted.screen()).toContain('waiting for your answer above');
    await mounted.keys('a');
    expect(mounted.session.resolutions).toEqual([
      { requestId: 'p1', action: { decision: 'allow' } },
    ]);
    expect(mounted.screen()).not.toContain('approval needed');
  });

  it('answers a question card by number', async () => {
    mounted = await mount();
    await mounted.event({
      type: 'question_request',
      requestId: 'q1',
      questions: [
        { question: 'Which?', header: 'Pick', options: [{ label: 'one' }, { label: 'two' }] },
      ],
    } as AgentEvent);
    expect(mounted.screen()).toContain('question · Pick');
    await mounted.keys('2');
    expect(mounted.session.answers[0]).toMatchObject({
      requestId: 'q1',
      resolution: { status: 'answered', answers: [{ answer: 'two' }] },
    });
  });

  it('opens the slash menu and the file menu from the prompt text', async () => {
    mounted = await mount({ listFiles: async () => ['src/parser.ts', 'README.md'] });
    await mounted.keys('/rew');
    expect(mounted.screen()).toMatch(/┌─ commands /);
    expect(mounted.screen()).toContain('› /rewind');
    await mounted.keys('\t');
    expect(mounted.screen()).toContain('│ › /rewind ');
    await mounted.keys('\x15@pars');
    await settle(60);
    await mounted.keys('');
    expect(mounted.screen()).toMatch(/┌─ files /);
    await mounted.keys('\t');
    expect(mounted.screen()).toContain('› @src/parser.ts');
  });

  it('queues a message with Tab during a run and sends it when the run ends', async () => {
    mounted = await mount();
    await mounted.keys('first\r');
    await mounted.event(userMessage('first'), text('working'));
    await mounted.keys('then this\t');
    expect(mounted.screen()).toContain(' queued  then this');
    await mounted.event(runFinished);
    expect(mounted.session.sent).toEqual(['first', 'then this']);
  });

  it('interrupts the run with Esc', async () => {
    mounted = await mount();
    await mounted.keys('go\r');
    await mounted.event(userMessage('go'), text('…'));
    await mounted.keys('\x1b', 120);
    expect(mounted.session.interrupt).toHaveBeenCalled();
  });

  it('expands every tool output with Ctrl+O, and collapses it again', async () => {
    mounted = await mount();
    const stdout = Array.from({ length: 8 }, (_, i) => `out ${i + 1}`).join('\n');
    await mounted.event(
      ...toolCall(
        'c1',
        'bash',
        { command: 'ls' },
        'ls',
        { stdout, stderr: '', exit_code: 0 },
        'ls (exit 0)',
      ),
      runFinished,
    );
    expect(mounted.screen()).toContain('… 5 more · ctrl+o');
    await mounted.keys('\x0f');
    expect(mounted.screen()).toContain('out 8');
    expect(mounted.screen()).not.toContain('… 5 more');
    await mounted.keys('\x1b[111;5u');
    expect(mounted.screen()).toContain('… 5 more · ctrl+o');
  });

  it('pages back through the transcript, holds still under new output, and follows again', async () => {
    mounted = await mount({}, { columns: 80, rows: 16 });
    for (let index = 0; index < 30; index += 1) {
      mounted.session.push({ type: 'user_message', content: `message ${index}` } as AgentEvent);
    }
    await settle(60);
    expect(mounted.screen()).toContain('message 29');
    await mounted.keys('\x1b[5~');
    expect(mounted.screen()).not.toContain('message 29');
    const held = mounted.term.screen().slice(0, 5);
    await mounted.event(userMessage('newest'));
    expect(mounted.term.screen().slice(0, 5)).toEqual(held);
    await mounted.keys('\x1b[1;5H');
    expect(mounted.screen()).toContain('chimera  v9.9.9');
    await mounted.keys('\x1b[1;5F');
    expect(mounted.screen()).toContain('newest');
    await mounted.keys('\x1b[5~');
    await mounted.keys('hello\r');
    expect(mounted.screen()).toContain('newest');
  });

  it('lays the screen out again after a resize', async () => {
    mounted = await mount({}, { columns: 100, rows: 20 });
    await mounted.event(
      userMessage('a message that is long enough to wrap when the terminal gets narrow'),
    );
    mounted.term.resize(50, 20);
    await settle();
    const rows = mounted.term.screen();
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(50);
    expect(rows.at(-4)).toMatch(/^╭─ build ─+ \? help ─╮$/);
    expect(rows.join('\n')).toContain('    you  a message that is long enough to');
  });
});

describe('handing the terminal over', () => {
  it('leaves the alternate screen and the key modes for $EDITOR, then redraws fully', async () => {
    let during: { alternate: boolean; modes: boolean } | undefined;
    mounted = await mount({
      openInEditor: async () => {
        during = { alternate: mounted!.term.alternate, modes: keyModesOn(mounted!.term) };
        mounted!.term.write('\x1b[2J\x1b[Heditor scribbles here');
        return { ok: true, text: 'from the editor' };
      },
    });
    await mounted.keys('draft\x07');
    expect(during).toEqual({ alternate: false, modes: false });
    expect(mounted.term.alternate).toBe(true);
    expect(keyModesOn(mounted.term)).toBe(true);
    expect(mounted.screen()).toContain('│ › from the editor');
    expect(mounted.screen()).not.toContain('scribbles');
  });

  it('does the same for the pager', async () => {
    let shown = '';
    mounted = await mount({
      openInPager: async ({ text: transcript }) => {
        shown = transcript;
        return { ok: true };
      },
    });
    await mounted.event(userMessage('hello'));
    await mounted.keys('\x14');
    expect(shown).toContain('hello');
    expect(mounted.term.alternate).toBe(true);
    expect(keyModesOn(mounted.term)).toBe(true);
  });

  it('suspends on Ctrl+Z and comes back on SIGCONT', async () => {
    mounted = await mount();
    await mounted.keys('\x1a');
    expect(mounted.signals.sent).toEqual(['SIGTSTP']);
    expect(mounted.term.alternate).toBe(false);
    expect(mounted.term.kittyFlags).toEqual([]);
    mounted.signals.deliver('SIGCONT');
    await settle();
    expect(mounted.term.alternate).toBe(true);
    expect(keyModesOn(mounted.term)).toBe(true);
    expect(mounted.screen()).toMatch(/╭─ build/);
  });

  it('restores the terminal on exit', async () => {
    mounted = await mount();
    const exit = vi.fn();
    void mounted.handle.waitUntilExit().then(exit);
    await mounted.keys('\x03');
    await mounted.keys('\x03');
    expect(exit).toHaveBeenCalled();
    expect(mounted.term.alternate).toBe(false);
    expect(mounted.term.kittyFlags).toEqual([]);
    expect(mounted.term.modes.has(1002)).toBe(false);
  });
});

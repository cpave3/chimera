import type { Checkpoint } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RewindPicker } from '../src/RewindPicker';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { pickBaseTheme } from '../src/theme/loader';

function withTheme(node: React.ReactElement) {
  const theme = pickBaseTheme();
  return (
    <ThemeProvider theme={theme} isUserTheme={false}>
      {node}
    </ThemeProvider>
  );
}

const TEST_CPS: Checkpoint[] = [
  { index: 0, userMessage: '', toolCallSummary: '', truncateByteOffset: 0 },
  { index: 1, userMessage: 'first prompt', toolCallSummary: '1 tool', truncateByteOffset: 100 },
  { index: 2, userMessage: 'second prompt', toolCallSummary: '2 tools', truncateByteOffset: 200 },
];

async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('RewindPicker', () => {
  it('renders checkpoints with summary', async () => {
    const rendered = render(
      withTheme(
        <RewindPicker
          checkpoints={TEST_CPS}
          onRewind={vi.fn()}
          onFork={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    const frame = rendered.lastFrame()!;
    expect(frame).toContain('Rewind to checkpoint');
    expect(frame).toContain('[1] first prompt');
    expect(frame).toContain('[2] second prompt');
    rendered.unmount();
  });

  it('Enter calls onRewind with the highlighted checkpoint', async () => {
    const onRewind = vi.fn();
    const rendered = render(
      withTheme(
        <RewindPicker
          checkpoints={TEST_CPS}
          onRewind={onRewind}
          onFork={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    rendered.stdin.write('\r');
    await tick();
    expect(onRewind).toHaveBeenCalledWith(TEST_CPS[0]);
    rendered.unmount();
  });

  it('Escape calls onCancel', async () => {
    const onCancel = vi.fn();
    const rendered = render(
      withTheme(
        <RewindPicker
          checkpoints={TEST_CPS}
          onRewind={vi.fn()}
          onFork={vi.fn()}
          onCancel={onCancel}
        />,
      ),
    );
    await tick();
    rendered.stdin.write('\x1b');
    await tick();
    expect(onCancel).toHaveBeenCalled();
    rendered.unmount();
  });

  it('arrow-down then Enter calls onRewind with the second checkpoint', async () => {
    const onRewind = vi.fn();
    const rendered = render(
      withTheme(
        <RewindPicker
          checkpoints={TEST_CPS}
          onRewind={onRewind}
          onFork={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    rendered.stdin.write('\x1b[B');
    await tick();
    rendered.stdin.write('\r');
    await tick();
    expect(onRewind).toHaveBeenCalledWith(TEST_CPS[1]);
    rendered.unmount();
  });

  it('arrow-down twice then SGR Shift+Enter calls onFork with the third checkpoint', async () => {
    const onFork = vi.fn();
    const rendered = render(
      withTheme(
        <RewindPicker
          checkpoints={TEST_CPS}
          onRewind={vi.fn()}
          onFork={onFork}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    // highlight 0 → 1 → 2
    rendered.stdin.write('\x1b[B');
    await tick();
    rendered.stdin.write('\x1b[B');
    await tick();
    // SGR Shift+Enter — Ink strips the leading ESC, so the handler sees '13;2u'.
    rendered.stdin.write('\x1b[13;2u');
    await tick();
    expect(onFork).toHaveBeenCalledWith(TEST_CPS[2]);
    rendered.unmount();
  });

  it('Ctrl+C closes the picker via onCancel', async () => {
    const onCancel = vi.fn();
    const rendered = render(
      withTheme(
        <RewindPicker
          checkpoints={TEST_CPS}
          onRewind={vi.fn()}
          onFork={vi.fn()}
          onCancel={onCancel}
        />,
      ),
    );
    await tick();
    rendered.stdin.write('\x03');
    await tick();
    expect(onCancel).toHaveBeenCalled();
    rendered.unmount();
  });

  it('j/k navigation selects the right checkpoint', async () => {
    const onRewind = vi.fn();
    const rendered = render(
      withTheme(
        <RewindPicker
          checkpoints={TEST_CPS}
          onRewind={onRewind}
          onFork={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );
    await tick();
    // highlight 0 → 1 → 2
    rendered.stdin.write('j');
    await tick();
    rendered.stdin.write('j');
    await tick();
    rendered.stdin.write('\r');
    await tick();
    expect(onRewind).toHaveBeenCalledWith(TEST_CPS[2]);
    rendered.unmount();
  });
});

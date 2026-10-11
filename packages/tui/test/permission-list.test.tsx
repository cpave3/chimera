import type { PermissionDecisionAction } from '@chimera/core';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { PermissionModal, type PermissionModalProps } from '../src/PermissionModal';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { defaultTheme } from '../src/theme/tokens';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function mount(props: Partial<PermissionModalProps> = {}) {
  const resolved: PermissionDecisionAction[] = [];
  const view = render(
    <ThemeProvider theme={defaultTheme}>
      <PermissionModal
        command="git push origin main"
        target="host"
        onResolve={(action) => resolved.push(action)}
        {...props}
      />
    </ThemeProvider>,
  );
  return { ...view, resolved };
}

async function press(stdin: { write: (data: string) => void }, ...keys: string[]) {
  for (const key of keys) {
    stdin.write(key);
    await settle();
  }
}

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';
const ESC = '\x1b';

describe('approval list', () => {
  it('lists the choices with the first one selected', async () => {
    const { lastFrame, unmount } = mount();
    await settle();

    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/› 1\. Allow once/);
    expect(frame).toMatch(/ {2}2\. Allow & remember/);
    expect(frame).toContain('Deny once');
    expect(frame).toContain('Deny with feedback');
    unmount();
  });

  it('applies the selected choice on Enter', async () => {
    const { stdin, resolved, unmount } = mount();
    await settle();

    await press(stdin, ENTER);

    expect(resolved).toEqual([{ decision: 'allow' }]);
    unmount();
  });

  it('moves the selection with the arrow keys', async () => {
    const { stdin, lastFrame, resolved, unmount } = mount();
    await settle();

    await press(stdin, DOWN, DOWN, DOWN);
    expect(lastFrame()).toMatch(/› 4\. Deny once/);
    await press(stdin, UP, DOWN, ENTER);

    expect(resolved).toEqual([{ decision: 'deny' }]);
    unmount();
  });

  it('picks a choice by its number', async () => {
    const { stdin, resolved, unmount } = mount();
    await settle();

    await press(stdin, '4');

    expect(resolved).toEqual([{ decision: 'deny' }]);
    unmount();
  });

  it('keeps the letter keys', async () => {
    const allowed = mount();
    await settle();
    await press(allowed.stdin, 'a');
    expect(allowed.resolved).toEqual([{ decision: 'allow' }]);
    allowed.unmount();

    const denied = mount();
    await settle();
    await press(denied.stdin, 'd');
    expect(denied.resolved).toEqual([{ decision: 'deny' }]);
    denied.unmount();
  });

  it('denies on Escape', async () => {
    const { stdin, resolved, unmount } = mount();
    await settle();

    await press(stdin, ESC);

    expect(resolved).toEqual([{ decision: 'deny' }]);
    unmount();
  });

  it('opens the follow-up step for a choice that needs one', async () => {
    const { stdin, lastFrame, resolved, unmount } = mount();
    await settle();

    await press(stdin, DOWN, ENTER);

    expect(lastFrame()).toContain('Remember for [s]ession');
    expect(resolved).toEqual([]);
    unmount();
  });
});

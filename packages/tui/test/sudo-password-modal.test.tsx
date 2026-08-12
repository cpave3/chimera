import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SudoPasswordModal } from '../src/SudoPasswordModal';

async function type(stdin: { write: (text: string) => void }, text: string): Promise<void> {
  for (const character of text) {
    stdin.write(character);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('SudoPasswordModal', () => {
  it('masks each typed character and submits password bytes once', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <SudoPasswordModal status="password" onSubmit={onSubmit} onCancel={() => {}} />,
    );

    await type(stdin as unknown as { write: (text: string) => void }, 'hunter2');

    expect(lastFrame()).toContain('•••••••');
    expect(lastFrame()).not.toContain('hunter2');

    (stdin as unknown as { write: (text: string) => void }).write('\r');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(Buffer.from(onSubmit.mock.calls[0]![0]).toString()).toBe('hunter2');
    unmount();
  });

  it('shows checking and validating states without accepting input', async () => {
    const onSubmit = vi.fn();
    const { lastFrame, stdin, rerender, unmount } = render(
      <SudoPasswordModal status="checking" onSubmit={onSubmit} onCancel={() => {}} />,
    );

    expect(lastFrame()).toContain('Checking cached sudo credentials');
    await type(stdin as unknown as { write: (text: string) => void }, 'secret');
    rerender(<SudoPasswordModal status="validating" onSubmit={onSubmit} onCancel={() => {}} />);

    expect(lastFrame()).toContain('Validating sudo credentials');
    expect(lastFrame()).not.toContain('secret');
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();
  });

  it('cancels on Escape without exposing the typed password', async () => {
    const onCancel = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <SudoPasswordModal status="password" onSubmit={() => {}} onCancel={onCancel} />,
    );
    await type(stdin as unknown as { write: (text: string) => void }, 'secret');

    (stdin as unknown as { write: (text: string) => void }).write('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(lastFrame()).not.toContain('secret');
    unmount();
  });
});

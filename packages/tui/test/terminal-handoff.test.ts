import { describe, expect, it, vi } from 'vitest';
import { withTerminalHandoff } from '../src/input/terminal-handoff';

function terminalStreams() {
  const rawModes: boolean[] = [];
  const lifecycle: string[] = [];
  const stdin = {
    isTTY: true,
    isRaw: true,
    setRawMode(value: boolean) {
      rawModes.push(value);
      lifecycle.push(`raw:${value}`);
      this.isRaw = value;
    },
    pause: vi.fn(),
    resume: vi.fn(),
    read: vi.fn(() => null),
    drainForTerminalHandoff: vi.fn(() => lifecycle.push('drain')),
  } as unknown as NodeJS.ReadStream;
  const writes: string[] = [];
  const stdout = {
    isTTY: true,
    write(value: string) {
      writes.push(value);
      return true;
    },
  } as NodeJS.WriteStream;
  return { stdin, stdout, rawModes, writes, lifecycle };
}

describe('withTerminalHandoff', () => {
  it('releases and restores terminal input around an operation', async () => {
    const { stdin, stdout, rawModes, writes, lifecycle } = terminalStreams();

    const result = await withTerminalHandoff({ stdin, stdout }, async () => {
      lifecycle.push('operation');
      return 'done';
    });

    expect(result).toBe('done');
    expect(rawModes).toEqual([false, true]);
    expect(stdin.pause).toHaveBeenCalledOnce();
    expect(stdin.resume).toHaveBeenCalledOnce();
    expect(writes).toEqual(['\x1b[?2004l', '\x1b[?2004h']);
    expect(lifecycle).toEqual(['raw:false', 'operation', 'drain', 'raw:true']);
  });

  it('restores terminal input when the operation throws', async () => {
    const { stdin, stdout, rawModes, writes } = terminalStreams();

    await expect(
      withTerminalHandoff({ stdin, stdout }, async () => {
        throw new Error('spawn failed');
      }),
    ).rejects.toThrow('spawn failed');

    expect(rawModes).toEqual([false, true]);
    expect(stdin.resume).toHaveBeenCalledOnce();
    expect(writes).toEqual(['\x1b[?2004l', '\x1b[?2004h']);
  });

  it('rejects a handoff without an owner-local TTY', async () => {
    const { stdin, stdout } = terminalStreams();
    Object.defineProperty(stdin, 'isTTY', { value: false });

    await expect(withTerminalHandoff({ stdin, stdout }, async () => 'done')).rejects.toThrow(
      'owner-local terminal',
    );
  });
});

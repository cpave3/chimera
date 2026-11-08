import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host';
import type { InputEvent } from '../src/terminal/keys';
import { VirtualInput, VirtualTerminal } from '../src/terminal/virtual-terminal';

function fakeSignals() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    sent: [] as string[],
    on(signal: string, handler: () => void) {
      if (!handlers.has(signal)) handlers.set(signal, new Set());
      handlers.get(signal)!.add(handler);
    },
    off(signal: string, handler: () => void) {
      handlers.get(signal)?.delete(handler);
    },
    kill(signal: string) {
      this.sent.push(signal);
    },
    deliver(signal: string) {
      for (const handler of [...(handlers.get(signal) ?? [])]) handler();
    },
    count(signal: string) {
      return handlers.get(signal)?.size ?? 0;
    },
  };
}

function setup(options: { mouse?: boolean } = {}) {
  const term = new VirtualTerminal({ columns: 40, rows: 10 });
  const input = new VirtualInput();
  const signals = fakeSignals();
  const events: InputEvent[] = [];
  const host = new TerminalHost({
    stdin: input,
    stdout: term,
    mouse: options.mouse ?? false,
    signals,
    onInput: (event) => events.push(event),
    escapeTimeoutMs: 5,
  });
  return { term, input, signals, events, host };
}

function keyModesOn(term: VirtualTerminal): boolean {
  return term.kittyFlags.length > 0 && term.modifyOtherKeys === 1 && term.modes.has(2004);
}

function keyModesOff(term: VirtualTerminal): boolean {
  return term.kittyFlags.length === 0 && term.modifyOtherKeys === 0 && !term.modes.has(2004);
}

describe('TerminalHost', () => {
  let host: TerminalHost | undefined;
  afterEach(() => host?.stop());

  it('turns on raw input, Kitty keys, modifyOtherKeys and bracketed paste on start', () => {
    const setup0 = setup();
    host = setup0.host;
    host.start();
    expect(setup0.input.isRaw).toBe(true);
    expect(setup0.term.kittyFlags).toEqual([1]);
    expect(setup0.term.modifyOtherKeys).toBe(1);
    expect(setup0.term.modes.has(2004)).toBe(true);
    expect(setup0.term.modes.has(1002)).toBe(false);
  });

  it('captures the mouse only when asked to', () => {
    const { term, host: mouseHost } = setup({ mouse: true });
    host = mouseHost;
    host.start();
    expect(term.modes.has(1002)).toBe(true);
    expect(term.modes.has(1006)).toBe(true);
    host.stop();
    expect(term.modes.has(1002)).toBe(false);
    expect(term.modes.has(1006)).toBe(false);
  });

  it('restores every mode on stop', () => {
    const { term, input, host: started } = setup();
    host = started;
    host.start();
    host.stop();
    expect(keyModesOff(term)).toBe(true);
    expect(input.isRaw).toBe(false);
  });

  it('delivers parsed input, and a lone Esc after the timeout', async () => {
    const { input, events, host: started } = setup();
    host = started;
    host.start();
    input.send('hi\r');
    expect(events.map((event) => event.type === 'key' && event.name)).toEqual(['h', 'i', 'enter']);
    input.send('\x1b');
    expect(events).toHaveLength(3);
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: 'key', name: 'escape' }));
  });

  it('restores the modes on suspend and turns them on again on resume', () => {
    const { term, input, signals, host: started } = setup({ mouse: true });
    host = started;
    const onSuspend = vi.fn();
    const onResume = vi.fn();
    host.onSuspend = onSuspend;
    host.onResume = onResume;
    host.start();
    host.suspend();
    expect(keyModesOff(term)).toBe(true);
    expect(term.modes.has(1002)).toBe(false);
    expect(input.isRaw).toBe(false);
    expect(signals.sent).toEqual(['SIGTSTP']);
    expect(onSuspend).toHaveBeenCalledOnce();
    signals.deliver('SIGCONT');
    expect(keyModesOn(term)).toBe(true);
    expect(term.modes.has(1002)).toBe(true);
    expect(input.isRaw).toBe(true);
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('suspends when the terminal sends SIGTSTP itself', () => {
    const { term, signals, host: started } = setup();
    host = started;
    host.start();
    signals.deliver('SIGTSTP');
    expect(keyModesOff(term)).toBe(true);
    expect(signals.sent).toEqual(['SIGTSTP']);
  });

  it('gives the terminal back for an editor, and takes it again after', async () => {
    const { term, input, events, host: started } = setup({ mouse: true });
    host = started;
    host.start();
    let duringHandoff: { keyModesOff: boolean; mouse: boolean } | undefined;
    const result = await host.handoff(async () => {
      duringHandoff = { keyModesOff: keyModesOff(term), mouse: term.modes.has(1002) };
      input.send('typed for the editor');
      return 'edited';
    });
    expect(result).toBe('edited');
    expect(duringHandoff).toEqual({ keyModesOff: true, mouse: false });
    expect(events).toEqual([]);
    expect(keyModesOn(term)).toBe(true);
    expect(term.modes.has(1002)).toBe(true);
    expect(input.isRaw).toBe(true);
  });

  it('stops listening for signals on stop', () => {
    const { signals, host: started } = setup();
    started.start();
    started.stop();
    expect(signals.count('SIGTSTP')).toBe(0);
    expect(signals.count('SIGCONT')).toBe(0);
  });
});

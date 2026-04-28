import { EventEmitter } from 'node:events';

/**
 * Translate `modifyOtherKeys` / kitty-style CSI 27 sequences for Enter into
 * the legacy `Esc Enter` byte pair so Ink's `useInput` reports
 * `key.meta && key.return` (which the prompt handler treats as a soft
 * newline). Ink's bundled keypress parser does not understand
 * `\x1b[27;<mod>;13~`, so without this filter the terminal's keystrokes
 * leak into the buffer as literal characters.
 *
 * Modifier semantics from xterm:
 *   2 = shift
 *   3 = alt
 *   4 = alt+shift
 *   5 = ctrl
 *   6 = ctrl+shift
 *   7 = ctrl+alt
 *   8 = ctrl+alt+shift
 *
 * Any modified Enter — Shift, Alt, Ctrl, or any combination — is rewritten
 * to `\n` (linefeed). `@jrichman/ink@6.6.9` parses `\n` as
 * `key.name === 'enter'` rather than `'return'`, so `key.return` stays
 * false (no submit) and the `\n` byte is delivered to `useInput` as the
 * `input` argument. The prompt's `insertChar` path then writes it into
 * the buffer at the cursor — exactly the desired Shift+Enter behavior.
 *
 * (We can't use `\x1b\r`: Ink's parser doesn't have a case for that pair
 * and it falls through to deliver `input='\r'` with `key.return=false`,
 * which inserts a literal `\r` into the buffer instead of a newline.)
 */
const MODIFIED_ENTER = /\x1b\[27;[2-8];13~/g;
const LEGACY_ALT_ENTER = /\x1b\r/g;

export function translateModifiedKeys(chunk: string): string {
  return chunk.replace(MODIFIED_ENTER, '\n').replace(LEGACY_ALT_ENTER, '\n');
}

/**
 * Wrap `upstream` (typically `process.stdin`) so Ink's `App` component sees
 * a translated byte stream while raw-mode and lifecycle calls still
 * delegate through to the real TTY. Ink reads input via `'readable'`
 * events + `.read()` (see `@jrichman/ink/build/components/App.js`), so the
 * wrapper implements pull-based reads rather than the push-based `'data'`
 * pattern. Behavior:
 *
 * 1. The wrapper does **not** listen to upstream until something subscribes
 *    to its `'readable'` event (Ink does this only after `setRawMode(true)`
 *    has been called). Listening to `process.stdin` before raw mode is
 *    enabled would put the terminal in line-buffered mode and freeze the
 *    user's typing — that was the failure mode of the previous attempt.
 * 2. On each upstream `'readable'`, we pull every chunk via
 *    `upstream.read()`, translate, push into an internal queue, and emit
 *    `'readable'` on the wrapper. Ink then calls `wrapper.read()` until it
 *    returns null — we serve translated chunks from the queue.
 * 3. `setRawMode`, `setEncoding`, `ref`, `unref`, `pause`, `resume` all
 *    delegate to `upstream`.
 */
export function createFilteredStdin(upstream: NodeJS.ReadStream): NodeJS.ReadStream {
  const wrapper = new EventEmitter() as EventEmitter & Partial<NodeJS.ReadStream>;
  const queue: string[] = [];
  let upstreamSubscribed = false;
  function pump(): void {
    let chunk: unknown;
    while ((chunk = upstream.read()) !== null) {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      const translated = translateModifiedKeys(text);
      if (translated.length > 0) queue.push(translated);
    }
    if (queue.length > 0) wrapper.emit('readable');
  }
  function ensureSubscribed(): void {
    if (upstreamSubscribed) return;
    upstreamSubscribed = true;
    upstream.on('readable', pump);
    upstream.on('end', () => wrapper.emit('end'));
    upstream.on('close', () => wrapper.emit('close'));
  }
  const baseOn = wrapper.on.bind(wrapper);
  const baseAddListener = wrapper.addListener.bind(wrapper);
  Object.assign(wrapper, {
    isTTY: upstream.isTTY,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'readable' || event === 'data') ensureSubscribed();
      return baseOn(event, listener);
    },
    addListener(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'readable' || event === 'data') ensureSubscribed();
      return baseAddListener(event, listener);
    },
    setRawMode(mode: boolean): NodeJS.ReadStream {
      upstream.setRawMode?.(mode);
      return wrapper as NodeJS.ReadStream;
    },
    setEncoding(encoding: BufferEncoding): NodeJS.ReadStream {
      upstream.setEncoding(encoding);
      return wrapper as NodeJS.ReadStream;
    },
    pause(): NodeJS.ReadStream {
      upstream.pause();
      return wrapper as NodeJS.ReadStream;
    },
    resume(): NodeJS.ReadStream {
      upstream.resume();
      return wrapper as NodeJS.ReadStream;
    },
    read(_size?: number): unknown {
      if (queue.length === 0) return null;
      return queue.shift() ?? null;
    },
    ref(): NodeJS.ReadStream {
      upstream.ref?.();
      return wrapper as NodeJS.ReadStream;
    },
    unref(): NodeJS.ReadStream {
      upstream.unref?.();
      return wrapper as NodeJS.ReadStream;
    },
  });
  return wrapper as NodeJS.ReadStream;
}

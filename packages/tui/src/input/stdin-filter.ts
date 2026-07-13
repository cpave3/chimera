import { EventEmitter } from 'node:events';
import { PasteRegistry, shouldCompactPaste } from './paste';

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
const MODIFIED_ENTER = new RegExp(`${String.fromCharCode(27)}\\[27;[2-8];13~`, 'g');
const LEGACY_ALT_ENTER = `${String.fromCharCode(27)}\r`;

export function translateModifiedKeys(chunk: string): string {
  return chunk.replace(MODIFIED_ENTER, '\n').replaceAll(LEGACY_ALT_ENTER, '\n');
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
export function createFilteredStdin(
  upstream: NodeJS.ReadStream,
  pasteRegistry?: PasteRegistry,
): NodeJS.ReadStream {
  const wrapper = new EventEmitter() as EventEmitter & Partial<NodeJS.ReadStream>;
  const queue: string[] = [];
  const pasteStart = '\x1b[200~';
  const pasteEnd = '\x1b[201~';
  let pendingInput = '';
  let pasteContent: string | null = null;
  let upstreamSubscribed = false;

  function markerPrefixLength(input: string, marker: string): number {
    for (let length = Math.min(marker.length - 1, input.length); length > 0; length -= 1) {
      if (input.endsWith(marker.slice(0, length))) return length;
    }
    return 0;
  }

  function processInput(chunk: string): void {
    pendingInput += chunk;
    while (pendingInput.length > 0) {
      if (pasteContent !== null) {
        const endIndex = pendingInput.indexOf(pasteEnd);
        if (endIndex < 0) {
          const retainedLength = markerPrefixLength(pendingInput, pasteEnd);
          pasteContent += pendingInput.slice(0, pendingInput.length - retainedLength);
          pendingInput = retainedLength > 0 ? pendingInput.slice(-retainedLength) : '';
          return;
        }
        pasteContent += pendingInput.slice(0, endIndex);
        pendingInput = pendingInput.slice(endIndex + pasteEnd.length);
        const output =
          pasteRegistry && shouldCompactPaste(pasteContent)
            ? pasteRegistry.register(pasteContent)
            : pasteContent;
        if (output.length > 0) queue.push(output);
        pasteContent = null;
        continue;
      }

      const startIndex = pendingInput.indexOf(pasteStart);
      if (startIndex < 0) {
        const retainedLength = markerPrefixLength(pendingInput, pasteStart);
        const output = pendingInput.slice(0, pendingInput.length - retainedLength);
        if (output.length > 0) queue.push(translateModifiedKeys(output));
        pendingInput = retainedLength > 0 ? pendingInput.slice(-retainedLength) : '';
        return;
      }
      const output = pendingInput.slice(0, startIndex);
      if (output.length > 0) queue.push(translateModifiedKeys(output));
      pendingInput = pendingInput.slice(startIndex + pasteStart.length);
      pasteContent = '';
    }
  }

  function pump(): void {
    let chunk: unknown = upstream.read();
    while (chunk !== null) {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      processInput(text);
      chunk = upstream.read();
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

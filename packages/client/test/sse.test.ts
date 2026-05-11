import { describe, expect, it, vi } from 'vitest';
import { parseSSE } from '../src/sse';

function makeMockStream(reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return {
    getReader: () => reader,
  } as unknown as ReadableStream<Uint8Array>;
}

function makeMockReader(opts: {
  cancelError?: unknown;
  releaseLockError?: unknown;
}): ReadableStreamDefaultReader<Uint8Array> {
  return {
    read: () => Promise.resolve({ done: true, value: undefined }),
    cancel: () => {
      if (opts.cancelError) return Promise.reject(opts.cancelError);
      return Promise.resolve();
    },
    releaseLock: () => {
      if (opts.releaseLockError) throw opts.releaseLockError;
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe('parseSSE', () => {
  it('suppresses debug when cancel throws AbortError by name only', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = Object.assign(new Error('foo'), { name: 'AbortError' });
    const reader = makeMockReader({ cancelError: error });
    const stream = makeMockStream(reader);
    await Array.fromAsync(parseSSE(stream, () => {}));
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('suppresses debug when cancel throws AbortError by message only', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // Plain Error carrying the spec message string without the abort name.
    const error = new Error('This operation was aborted');
    const reader = makeMockReader({ cancelError: error });
    const stream = makeMockStream(reader);
    await Array.fromAsync(parseSSE(stream, () => {}));
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('suppresses debug when releaseLock throws DOMException-like abort', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    // DOMException does not inherit from Error in Node.js.
    const error = { name: 'AbortError', message: 'The operation was aborted' };
    const reader = makeMockReader({ releaseLockError: error });
    const stream = makeMockStream(reader);
    await Array.fromAsync(parseSSE(stream, () => {}));
    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('still logs non-abort errors', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = new Error('some other failure');
    const reader = makeMockReader({ cancelError: error, releaseLockError: error });
    const stream = makeMockStream(reader);
    await Array.fromAsync(parseSSE(stream, () => {}));
    expect(debugSpy).toHaveBeenCalledTimes(2);
    debugSpy.mockRestore();
  });
});

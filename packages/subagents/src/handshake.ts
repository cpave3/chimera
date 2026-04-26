import type { Readable } from 'node:stream';

export interface HandshakeMessage {
  ready: true;
  url: string;
  sessionId: string;
  pid: number;
}

export class HandshakeError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: string,
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

/**
 * Read exactly one newline-terminated JSON line from a child's stdout. The
 * returned promise rejects on:
 *   - timeout exceeded with no newline yet,
 *   - stdout ending before a newline arrived,
 *   - the line not parsing as the expected handshake shape.
 *
 * On success the stream is left in a half-drained state — callers should
 * either keep it for further use (we don't), or detach all listeners.
 */
export function readHandshakeLine(stdout: Readable, timeoutMs: number): Promise<HandshakeMessage> {
  return new Promise<HandshakeMessage>((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      stdout.off('data', onData);
      stdout.off('end', onEnd);
      stdout.off('error', onError);
      clearTimeout(timer);
    };

    const settle = (err: HandshakeError | null, msg?: HandshakeMessage): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(msg!);
    };

    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        settle(new HandshakeError('child handshake line was not valid JSON', (e as Error).message));
        return;
      }
      if (!isHandshakeMessage(parsed)) {
        settle(new HandshakeError('child handshake JSON missing required fields', line));
        return;
      }
      settle(null, parsed);
    };

    const onEnd = () => {
      settle(
        new HandshakeError(
          'child stdout closed before emitting a handshake line',
          buf.length > 0 ? buf.slice(0, 200) : undefined,
        ),
      );
    };

    const onError = (err: Error) => {
      settle(new HandshakeError(`child stdout error: ${err.message}`));
    };

    const timer = setTimeout(() => {
      settle(
        new HandshakeError(
          `child handshake timed out after ${timeoutMs}ms`,
          buf.length > 0 ? buf.slice(0, 200) : undefined,
        ),
      );
    }, timeoutMs);

    stdout.on('data', onData);
    stdout.on('end', onEnd);
    stdout.on('error', onError);
  });
}

function isHandshakeMessage(v: unknown): v is HandshakeMessage {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.ready === true &&
    typeof o.url === 'string' &&
    typeof o.sessionId === 'string' &&
    typeof o.pid === 'number'
  );
}

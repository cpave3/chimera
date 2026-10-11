import { APICallError } from 'ai';

export type ProviderFailure =
  /** The prompt does not fit the model's context window. */
  | { kind: 'overflow'; message: string }
  /** The provider is likely to accept the same request later. */
  | { kind: 'temporary'; message: string; retryAfterMs?: number }
  | { kind: 'fatal'; message: string };

const OVERFLOW_PATTERN =
  /context[ _-]?(length|window|limit|size)|maximum context|prompt is too long|input is too long|too many (input )?tokens|exceeds? .{0,40}(context|token limit|maximum.{0,20}tokens)|reduce the length/i;

const TEMPORARY_PATTERN =
  /overloaded|rate[ _-]?limit|too many requests|temporarily unavailable|service unavailable|bad gateway|gateway timeout|timed? ?out|econnreset|econnrefused|etimedout|epipe|socket hang up|fetch failed|network error|terminated|connection (closed|reset|error)/i;

const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Sort a failed model step into what the run loop can do about it. Errors
 * reach the loop in several shapes: an `APICallError` for a rejected request,
 * a plain object for an error event inside an already-open stream (Anthropic
 * sends `{ type: 'overloaded_error', message }`), or a network-level `Error`.
 */
export function classifyProviderError(error: unknown): ProviderFailure {
  const message = describeProviderError(error);
  if (APICallError.isInstance(error)) {
    const detail = `${message} ${error.responseBody ?? ''}`;
    const status = error.statusCode;
    if ((status === 400 || status === 413 || status === 422) && OVERFLOW_PATTERN.test(detail)) {
      return { kind: 'overflow', message };
    }
    const temporaryStatus =
      status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
    if (error.isRetryable || temporaryStatus) {
      return { kind: 'temporary', message, retryAfterMs: retryAfterMs(error.responseHeaders) };
    }
    return { kind: 'fatal', message };
  }
  if (OVERFLOW_PATTERN.test(message)) return { kind: 'overflow', message };
  if (TEMPORARY_PATTERN.test(message)) return { kind: 'temporary', message };
  return { kind: 'fatal', message };
}

export function describeProviderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { type, message } = error as { type?: unknown; message?: unknown };
    if (typeof message === 'string') {
      return typeof type === 'string' ? `${type}: ${message}` : message;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  if (!headers) return undefined;
  const milliseconds = Number(headers['retry-after-ms']);
  if (
    Number.isFinite(milliseconds) &&
    milliseconds >= 0 &&
    headers['retry-after-ms'] !== undefined
  ) {
    return Math.min(MAX_RETRY_AFTER_MS, milliseconds);
  }
  const header = headers['retry-after'];
  if (header === undefined) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
}

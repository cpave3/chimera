import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_FIELD_BYTES = 4 * 1024;
const REDACTED_KEYS = ['apikey', 'apiKey', 'api_key', 'authorization', 'Authorization'];

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  [key: string]: unknown;
}

export interface LoggerOptions {
  home?: string;
  verbose?: boolean;
}

export function logsDir(home = homedir()): string {
  return join(home, '.chimera', 'logs');
}

export function logFilePath(home = homedir()): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(logsDir(home), `${date}.log`);
}

export function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return truncate(value);
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACTED_KEYS.includes(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

function truncate(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (Buffer.byteLength(v, 'utf8') <= MAX_FIELD_BYTES) return v;
  return `${v.slice(0, MAX_FIELD_BYTES)}…[truncated]`;
}

export class Logger {
  private readonly filePath: string;
  private readonly verbose: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.filePath = logFilePath(opts.home);
    this.verbose = opts.verbose ?? false;
    try {
      mkdirSync(logsDir(opts.home), { recursive: true });
    } catch {
      // ignore
    }
  }

  log(record: LogRecord): void {
    const redacted = redact(record) as Record<string, unknown>;
    const line = `${JSON.stringify({ ts: Date.now(), ...redacted })}\n`;
    try {
      appendFileSync(this.filePath, line, 'utf8');
    } catch {
      // best-effort
    }
    if (this.verbose) {
      process.stderr.write(line);
    }
  }

  info(message: string, extras: Record<string, unknown> = {}): void {
    this.log({ level: 'info', message, ...extras });
  }
  warn(message: string, extras: Record<string, unknown> = {}): void {
    this.log({ level: 'warn', message, ...extras });
  }
  error(message: string, extras: Record<string, unknown> = {}): void {
    this.log({ level: 'error', message, ...extras });
  }
  debug(message: string, extras: Record<string, unknown> = {}): void {
    this.log({ level: 'debug', message, ...extras });
  }
}

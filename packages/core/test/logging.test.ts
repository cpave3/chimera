import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger, logFilePath, redact } from '../src/logging';

describe('redact', () => {
  it('replaces apiKey fields at any nesting', () => {
    const out = redact({ config: { providers: { anthropic: { apiKey: 'sk-xxx' } } } });
    expect(JSON.stringify(out)).not.toContain('sk-xxx');
    expect(JSON.stringify(out)).toContain('[REDACTED]');
  });

  it('truncates strings above 4 KB', () => {
    const big = 'a'.repeat(5000);
    const out = redact({ text: big }) as { text: string };
    expect(out.text.length).toBeLessThan(5000);
    expect(out.text.endsWith('[truncated]')).toBe(true);
  });
});

describe('Logger', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-log-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('writes JSON lines to the date-stamped log file', () => {
    const logger = new Logger({ home });
    logger.info('hello', { answer: 42 });
    const contents = readFileSync(logFilePath(home), 'utf8');
    expect(contents).toMatch(/hello/);
    const line = contents.trim().split('\n').pop()!;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe('info');
    expect(parsed.answer).toBe(42);
  });

  it('never logs raw apiKey values', () => {
    const logger = new Logger({ home });
    logger.info('config loaded', { providers: { openai: { apiKey: 'sk-secret-zzz' } } });
    const contents = readFileSync(logFilePath(home), 'utf8');
    expect(contents).not.toContain('sk-secret-zzz');
    expect(contents).toContain('[REDACTED]');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (name: string) =>
  readFileSync(join(import.meta.dirname, '..', 'src', 'commands', name), 'utf8');

describe('where background updates run', () => {
  it('runs them for the TUI and chimera serve, and never for chimera run', () => {
    expect(source('interactive.ts')).toContain('startBackgroundUpdates(');
    expect(source('serve.ts')).toContain('startBackgroundUpdates(');
    expect(source('run.ts')).not.toMatch(/startBackgroundUpdates|Updater/);
  });
});

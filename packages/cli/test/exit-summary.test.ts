import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { formatExitSummary, instructionFileNotices } from '../src/commands/interactive';

it('names the session and the command that resumes it', () => {
  const summary = formatExitSummary('01ABCDEFGH8AWWBRGC');
  expect(summary).toContain('session 01ABCDEFGH8AWWBRGC');
  expect(summary).toContain('chimera --session 01ABCDEFGH8AWWBRGC');
});

it('tells the user about an instruction file that was cut', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'chimera-notice-'));
  try {
    writeFileSync(join(cwd, 'AGENTS.md'), 'x'.repeat(50 * 1024));
    expect(instructionFileNotices(cwd, cwd)).toEqual([
      expect.stringMatching(/AGENTS\.md is 50 KiB; only its first 32 KiB are used/),
    ]);
    writeFileSync(join(cwd, 'AGENTS.md'), 'short');
    expect(instructionFileNotices(cwd, cwd)).toEqual([]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

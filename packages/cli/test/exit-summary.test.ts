import { expect, it } from 'vitest';
import { formatExitSummary } from '../src/commands/interactive';

it('names the session and the command that resumes it', () => {
  const summary = formatExitSummary('01ABCDEFGH8AWWBRGC');
  expect(summary).toContain('session 01ABCDEFGH8AWWBRGC');
  expect(summary).toContain('chimera --session 01ABCDEFGH8AWWBRGC');
});

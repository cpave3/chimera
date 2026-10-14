import { project, replaceInFile, runTests } from './checks';
import type { EvalTask } from './types';

const limitsFiles = project({
  'src/limits.js': `export function freeTierLimits() {
  return {
    requestsPerMinute: 60,
    burst: 10,
  };
}

export function proTierLimits() {
  return {
    requestsPerMinute: 60,
    burst: 10,
  };
}
`,
});

const datesFiles = project({
  'src/lib/dates.js': `const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function daysBetween(first, second) {
  return Math.round((second.getTime() - first.getTime()) / MS_PER_DAY);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}
`,
  'src/lib/strings.js': `export function padLeft(text, width) {
  return text.padStart(width, ' ');
}
`,
  'src/index.js': `export { addDays, daysBetween } from './lib/dates.js';
export { padLeft } from './lib/strings.js';
`,
});

export const RECOVER_TASKS: EvalTask[] = [
  {
    id: 'ambiguous-edit',
    category: 'recover',
    probes: 'Recovering when the edit tool refuses a string that matches in two places.',
    prompt:
      'In src/limits.js, raise requestsPerMinute for the pro tier to 600. The free tier stays at 60.',
    files: limitsFiles,
    check: ({ workspace }) =>
      runTests(workspace, {
        '.eval-check/limits.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freeTierLimits, proTierLimits } from '../src/limits.js';

test('only the pro tier changed', () => {
  assert.deepEqual(freeTierLimits(), { requestsPerMinute: 60, burst: 10 });
  assert.deepEqual(proTierLimits(), { requestsPerMinute: 600, burst: 10 });
});
`,
      }),
    solve: (workspace) => {
      replaceInFile(
        workspace,
        'src/limits.js',
        'proTierLimits() {\n  return {\n    requestsPerMinute: 60,',
        'proTierLimits() {\n  return {\n    requestsPerMinute: 600,',
      );
      return undefined;
    },
  },
  {
    id: 'wrong-path',
    category: 'recover',
    probes: 'Looking for the real file when the path the user gave does not exist.',
    prompt:
      'In src/utils/date.js, daysBetween returns a negative number when the first date is later than the second. Make it always return a number of days that is zero or more.',
    files: datesFiles,
    check: ({ workspace }) =>
      runTests(workspace, {
        '.eval-check/dates.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, daysBetween } from '../src/index.js';

test('daysBetween does not depend on the order of the dates', () => {
  const start = new Date('2024-03-01T00:00:00Z');
  const end = new Date('2024-03-11T00:00:00Z');
  assert.equal(daysBetween(start, end), 10);
  assert.equal(daysBetween(end, start), 10);
  assert.equal(daysBetween(start, start), 0);
});

test('addDays is as it was', () => {
  const start = new Date('2024-03-01T00:00:00Z');
  assert.equal(addDays(start, 2).toISOString(), '2024-03-03T00:00:00.000Z');
});
`,
      }),
    solve: (workspace) => {
      replaceInFile(
        workspace,
        'src/lib/dates.js',
        'return Math.round((second.getTime() - first.getTime()) / MS_PER_DAY);',
        'return Math.abs(Math.round((second.getTime() - first.getTime()) / MS_PER_DAY));',
      );
      return undefined;
    },
  },
];

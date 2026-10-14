import { project, replaceInFile, runTests } from './checks';
import type { EvalTask } from './types';

const PAGINATION_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pageCount, paginate } from '../src/pagination.js';

const items = ['a', 'b', 'c', 'd', 'e'];

test('page 1 is the first page', () => {
  assert.deepEqual(paginate(items, 1, 2), ['a', 'b']);
});

test('the last page can be short', () => {
  assert.deepEqual(paginate(items, 3, 2), ['e']);
});

test('pageCount rounds up', () => {
  assert.equal(pageCount(items, 2), 3);
});
`;

const paginationFiles = project({
  'src/pagination.js': `export function paginate(items, page, pageSize) {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}

export function pageCount(items, pageSize) {
  return Math.ceil(items.length / pageSize);
}
`,
  'test/pagination.test.js': PAGINATION_TEST,
});

const STATS_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { average, median } from '../src/stats.js';

test('average of numbers', () => {
  assert.equal(average([2, 4, 6]), 4);
});

test('average of an empty list is 0', () => {
  assert.equal(average([]), 0);
});

test('median of an even count', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
`;

const TEXT_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capitalize, wordCount } from '../src/text.js';

test('capitalize', () => {
  assert.equal(capitalize('hello'), 'Hello');
});

test('wordCount ignores extra spaces', () => {
  assert.equal(wordCount('  one   two three '), 3);
});

test('wordCount of an empty string is 0', () => {
  assert.equal(wordCount(''), 0);
});
`;

const twoBugsFiles = project({
  'src/stats.js': `export function average(numbers) {
  const sum = numbers.reduce((total, value) => total + value, 0);
  return sum / numbers.length;
}

export function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
`,
  'src/text.js': `export function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function wordCount(text) {
  return text.split(' ').length;
}
`,
  'test/stats.test.js': STATS_TEST,
  'test/text.test.js': TEXT_TEST,
});

export const VERIFY_TASKS: EvalTask[] = [
  {
    id: 'fix-failing-test',
    category: 'verify',
    probes: 'Running the tests, reading the failure, fixing the source and not the test.',
    prompt:
      'The tests fail. Run them with `npm test`, find the bug in the source code and fix it. Do not change the tests.',
    files: paginationFiles,
    check: ({ workspace }) => runTests(workspace, { 'test/pagination.test.js': PAGINATION_TEST }),
    solve: (workspace) => {
      replaceInFile(workspace, 'src/pagination.js', 'page * pageSize', '(page - 1) * pageSize');
      return undefined;
    },
  },
  {
    id: 'fix-two-bugs',
    category: 'verify',
    probes: 'Staying in the test loop until both of two unrelated failures are fixed.',
    prompt:
      'Several tests fail. Run `npm test` and fix the source code until every test passes. Do not change the tests.',
    files: twoBugsFiles,
    check: ({ workspace }) =>
      runTests(workspace, { 'test/stats.test.js': STATS_TEST, 'test/text.test.js': TEXT_TEST }),
    solve: (workspace) => {
      replaceInFile(
        workspace,
        'src/stats.js',
        'return sum / numbers.length;',
        'return numbers.length === 0 ? 0 : sum / numbers.length;',
      );
      replaceInFile(
        workspace,
        'src/text.js',
        "return text.split(' ').length;",
        'return text.split(/\\s+/).filter(Boolean).length;',
      );
      return undefined;
    },
  },
];

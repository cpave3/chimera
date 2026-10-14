import { all, expectUnchanged, replaceInFile, runTests } from './checks';
import { shopProject } from './shop-project';
import type { EvalTask } from './types';

const shopFiles = shopProject();

export const NAVIGATE_TASKS: EvalTask[] = [
  {
    id: 'find-and-fix',
    category: 'navigate',
    probes: 'Searching 30 files for a bug that the user describes by its symptom, past a decoy.',
    prompt:
      'Prices in the product list show three decimal places, like $4.500. They must show two, like $4.50. Find the bug and fix it.',
    files: shopFiles,
    check: ({ workspace }) =>
      runTests(workspace, {
        '.eval-check/display.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatInvoiceTotal } from '../src/billing/currency.js';
import { formatPrice, productLine } from '../src/catalog/display.js';
import { formatWeight } from '../src/shipping/weight.js';

test('prices have two decimal places', () => {
  assert.equal(formatPrice(4.5), '$4.50');
  assert.equal(productLine({ name: 'Tea', price: 12 }), 'Tea: $12.00');
});

test('weights and invoice totals are as they were', () => {
  assert.equal(formatWeight(1.5), '1.500 kg');
  assert.equal(formatInvoiceTotal(10), '10.00');
});
`,
      }),
    solve: (workspace) => {
      replaceInFile(workspace, 'src/catalog/display.js', 'toFixed(3)', 'toFixed(2)');
      return undefined;
    },
  },
  {
    id: 'answer-question',
    category: 'navigate',
    probes: 'Answering from the code, not from a guess, and leaving the files alone.',
    prompt:
      'How many times does this project retry a failed payment before it gives up, and which file sets that number? Do not change any files.',
    files: shopFiles,
    check: ({ workspace, finalText }) =>
      all(
        expectUnchanged(shopFiles, workspace),
        /\b(4|four)\b/i.test(finalText) && finalText.includes('retry-policy')
          ? { pass: true, detail: 'The answer names 4 retries and retry-policy.js.' }
          : { pass: false, detail: 'The answer does not name both 4 and retry-policy.js.' },
      ),
    solve: () => ({
      finalText:
        'A failed payment is retried 4 times. MAX_PAYMENT_RETRIES in src/billing/retry-policy.js sets it.',
    }),
  },
];

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspace } from '../workspace';
import { all, changedLines, project, readFile, replaceInFile, runTests } from './checks';
import type { EvalTask } from './types';

const HANDLER_COUNT = 120;
const HANDLER_TO_CHANGE = 87;

function handlerName(index: number): string {
  return `handler${String(index).padStart(3, '0')}`;
}

function handlersSource(): string {
  const lines: string[] = ['// Request handlers, one for each route.', ''];
  for (let index = 1; index <= HANDLER_COUNT; index += 1) {
    const name = handlerName(index);
    lines.push(
      `export function ${name}(request) {`,
      `  const label = '${name}';`,
      "  return { status: 200, body: label + ':' + request.id };",
      '}',
      '',
    );
  }
  return lines.join('\n');
}

const singleLineFiles = project({
  'src/config.js': `export const config = {
  retries: 3,
  timeoutMs: 5000,
  baseUrl: 'https://api.example.test',
};
`,
});

const multiSiteFiles = project({
  'src/cart.js': `export function calcTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function describeCart(items) {
  return \`\${items.length} items, total \${calcTotal(items)}\`;
}

export function isFreeShipping(items) {
  return calcTotal(items) >= 100;
}
`,
  'src/checkout.js': `import { calcTotal, isFreeShipping } from './cart.js';

export function checkout(items) {
  const total = calcTotal(items);
  return { total, shipping: isFreeShipping(items) ? 0 : 8 };
}
`,
  'test/cart.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calcTotal } from '../src/cart.js';

test('calcTotal multiplies price by quantity', () => {
  assert.equal(calcTotal([{ price: 5, quantity: 3 }]), 15);
});
`,
});

const tabsFiles = project({
  'src/shipping.js': [
    'export function shippingCost(order) {',
    '\tif (order.items.length === 0) {',
    '\t\treturn 0;',
    '\t}',
    "\tif (order.country === 'NZ') {",
    '\t\tif (order.weightKg > 20) {',
    '\t\t\treturn 45;',
    '\t\t}',
    '\t\treturn 12;',
    '\t}',
    '\tif (order.weightKg > 20) {',
    '\t\treturn 80;',
    '\t}',
    '\treturn 25;',
    '}',
    '',
  ].join('\n'),
});

const largeFileFiles = project({ 'src/handlers.js': handlersSource() });

const createFileFiles = project({
  'src/index.js': `export function titleCase(text) {
  return text.replace(/\\b[a-z]/g, (letter) => letter.toUpperCase());
}
`,
});

export const EDIT_TASKS: EvalTask[] = [
  {
    id: 'edit-single-line',
    category: 'edit',
    probes: 'The read-then-edit loop on the smallest possible change.',
    prompt: 'In src/config.js, change the request timeout from 5000 ms to 8000 ms.',
    files: singleLineFiles,
    check: ({ workspace }) =>
      runTests(workspace, {
        '.eval-check/config.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';

test('only the timeout changed', () => {
  assert.deepEqual(config, {
    retries: 3,
    timeoutMs: 8000,
    baseUrl: 'https://api.example.test',
  });
});
`,
      }),
    solve: (workspace) => {
      replaceInFile(workspace, 'src/config.js', 'timeoutMs: 5000', 'timeoutMs: 8000');
      return undefined;
    },
  },
  {
    id: 'edit-multi-site',
    category: 'edit',
    probes: 'Several edits in three files, without leaving one use of the old name behind.',
    prompt: 'Rename the function calcTotal to calculateTotal everywhere it is used.',
    files: multiSiteFiles,
    check: ({ workspace }) => {
      const leftovers = Object.entries(readWorkspace(workspace))
        .filter(([path, content]) => path.endsWith('.js') && /\bcalcTotal\b/.test(content))
        .map(([path]) => path);
      if (leftovers.length > 0) {
        return { pass: false, detail: `calcTotal is still used in: ${leftovers.join(', ')}` };
      }
      return runTests(workspace, {
        '.eval-check/cart.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateTotal, describeCart, isFreeShipping } from '../src/cart.js';
import { checkout } from '../src/checkout.js';

test('the renamed function and its callers work', () => {
  const items = [{ price: 60, quantity: 2 }];
  assert.equal(calculateTotal(items), 120);
  assert.equal(describeCart(items), '1 items, total 120');
  assert.equal(isFreeShipping(items), true);
  assert.deepEqual(checkout(items), { total: 120, shipping: 0 });
});
`,
      });
    },
    solve: (workspace) => {
      for (const [path, content] of Object.entries(readWorkspace(workspace))) {
        if (!path.endsWith('.js')) continue;
        writeFileSync(join(workspace, path), content.replaceAll('calcTotal', 'calculateTotal'));
      }
      return undefined;
    },
  },
  {
    id: 'edit-tabs',
    category: 'edit',
    probes: 'An exact-string edit in a file indented with tabs, three levels deep.',
    prompt:
      'In src/shipping.js, an order over 20 kg that ships to NZ must cost 55, not 45. Keep the tab indentation of the file.',
    files: tabsFiles,
    check: ({ workspace }) => {
      const source = readFile(workspace, 'src/shipping.js') ?? '';
      if (/^ +\S/m.test(source)) {
        return { pass: false, detail: 'src/shipping.js has lines indented with spaces.' };
      }
      return runTests(workspace, {
        '.eval-check/shipping.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shippingCost } from '../src/shipping.js';

test('only the heavy NZ price changed', () => {
  const order = (country, weightKg) => ({ items: [1], country, weightKg });
  assert.equal(shippingCost(order('NZ', 30)), 55);
  assert.equal(shippingCost(order('NZ', 5)), 12);
  assert.equal(shippingCost(order('US', 30)), 80);
  assert.equal(shippingCost(order('US', 5)), 25);
  assert.equal(shippingCost({ items: [], country: 'NZ', weightKg: 30 }), 0);
});
`,
      });
    },
    solve: (workspace) => {
      replaceInFile(workspace, 'src/shipping.js', 'return 45;', 'return 55;');
      return undefined;
    },
  },
  {
    id: 'edit-large-file',
    category: 'edit',
    probes: 'Finding one function in a 600-line file of near-identical functions and changing it.',
    prompt: `In src/handlers.js, ${handlerName(HANDLER_TO_CHANGE)} must return status 202 instead of 200. Change nothing else.`,
    files: largeFileFiles,
    check: ({ workspace }) => {
      const original = largeFileFiles['src/handlers.js']!;
      const changed = changedLines(original, readFile(workspace, 'src/handlers.js') ?? '');
      if (!changed) return { pass: false, detail: 'The number of lines in the file changed.' };
      if (changed.length !== 1) {
        return { pass: false, detail: `${changed.length} lines changed; expected 1.` };
      }
      return runTests(workspace, {
        '.eval-check/handlers.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as handlers from '../src/handlers.js';

test('only ${handlerName(HANDLER_TO_CHANGE)} returns 202', () => {
  for (const [name, handler] of Object.entries(handlers)) {
    const expected = name === '${handlerName(HANDLER_TO_CHANGE)}' ? 202 : 200;
    assert.deepEqual(handler({ id: 7 }), { status: expected, body: name + ':7' });
  }
});
`,
      });
    },
    solve: (workspace) => {
      const name = handlerName(HANDLER_TO_CHANGE);
      replaceInFile(
        workspace,
        'src/handlers.js',
        `  const label = '${name}';\n  return { status: 200,`,
        `  const label = '${name}';\n  return { status: 202,`,
      );
      return undefined;
    },
  },
  {
    id: 'create-file',
    category: 'edit',
    probes: 'Writing a new file from a written specification.',
    prompt:
      "Create src/slugify.js. It must export a function slugify(text) that trims the text, makes it lowercase, replaces each run of characters that are not a-z or 0-9 with one hyphen, and removes hyphens from the start and the end. Example: slugify('  Hello, World! ') returns 'hello-world'.",
    files: createFileFiles,
    check: ({ workspace }) =>
      all(
        readFile(workspace, 'src/slugify.js') === undefined
          ? { pass: false, detail: 'src/slugify.js does not exist.' }
          : { pass: true, detail: 'src/slugify.js exists.' },
        runTests(workspace, {
          '.eval-check/slugify.test.js': `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.js';

test('slugify follows the specification', () => {
  assert.equal(slugify('  Hello, World! '), 'hello-world');
  assert.equal(slugify('Already-Slugged'), 'already-slugged');
  assert.equal(slugify('a  --  b'), 'a-b');
  assert.equal(slugify('Version 2.0 (beta)'), 'version-2-0-beta');
  assert.equal(slugify('!!!'), '');
});
`,
        }),
      ),
    solve: (workspace) => {
      writeFileSync(
        join(workspace, 'src/slugify.js'),
        `export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
      );
      return undefined;
    },
  },
];

import type { WorkspaceFiles } from '../workspace';
import { project } from './checks';

const AREAS: Record<string, string[]> = {
  billing: ['invoice', 'tax', 'refund', 'retry-policy', 'currency'],
  catalog: ['display', 'search', 'inventory', 'categories', 'pricing'],
  orders: ['create', 'cancel', 'sync', 'status', 'history'],
  users: ['profile', 'auth', 'preferences', 'sessions', 'roles'],
  shipping: ['weight', 'zones', 'tracking', 'labels', 'rates'],
  util: ['strings', 'dates', 'ids', 'logger', 'validate'],
};

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function pascalCase(name: string): string {
  const camel = camelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function fillerModule(area: string, name: string): string {
  const subject = pascalCase(name);
  return `import { logEvent } from '../util/logger.js';

export function load${subject}(record) {
  logEvent('${area}.${name}.load', record.id);
  return { ...record, ${camelCase(name)}Loaded: true };
}

export function is${subject}Ready(record) {
  return record !== null && record.locked !== true;
}

export function describe${subject}(record) {
  return \`${area}/${name} #\${record.id}\`;
}
`;
}

const SPECIAL_MODULES: WorkspaceFiles = {
  'src/util/logger.js': `const events = [];

export function logEvent(name, id) {
  events.push({ name, id });
}

export function recentEvents() {
  return events.slice(-20);
}
`,
  'src/catalog/display.js': `export function formatPrice(amount) {
  return \`$\${amount.toFixed(3)}\`;
}

export function productLine(product) {
  return \`\${product.name}: \${formatPrice(product.price)}\`;
}

export function productList(products) {
  return products.map(productLine).join('\\n');
}
`,
  'src/shipping/weight.js': `// Carriers bill by the gram, so weights keep three decimal places.
export function formatWeight(kilograms) {
  return \`\${kilograms.toFixed(3)} kg\`;
}

export function totalWeight(items) {
  return items.reduce((sum, item) => sum + item.weightKg * item.quantity, 0);
}
`,
  'src/billing/currency.js': `export function formatInvoiceTotal(total) {
  return total.toFixed(2);
}

export function toCents(amount) {
  return Math.round(amount * 100);
}
`,
  'src/billing/retry-policy.js': `// A declined card is tried again after a delay that doubles each time.
export const MAX_PAYMENT_RETRIES = 4;
export const FIRST_RETRY_DELAY_MS = 2000;

export function shouldRetryPayment(retriesSoFar) {
  return retriesSoFar < MAX_PAYMENT_RETRIES;
}

export function retryDelayMs(retriesSoFar) {
  return FIRST_RETRY_DELAY_MS * 2 ** retriesSoFar;
}
`,
  'src/orders/sync.js': `import { logEvent } from '../util/logger.js';

const SYNC_RETRIES = 2;

export async function syncOrder(order, send) {
  for (let attempt = 0; attempt <= SYNC_RETRIES; attempt += 1) {
    try {
      return await send(order);
    } catch {
      logEvent('orders.sync.failed', order.id);
    }
  }
  return null;
}
`,
  'src/shipping/rates.js': `const RATE_LOOKUP_ATTEMPTS = 3;

export function lookupRate(zone, table) {
  for (let attempt = 0; attempt < RATE_LOOKUP_ATTEMPTS; attempt += 1) {
    const rate = table[zone];
    if (rate !== undefined) return rate;
  }
  return null;
}
`,
};

/** A 30-module shop back end: large enough that a model has to search it. */
export function shopProject(): WorkspaceFiles {
  const files: WorkspaceFiles = {};
  for (const [area, names] of Object.entries(AREAS)) {
    for (const name of names) {
      const path = `src/${area}/${name}.js`;
      files[path] = SPECIAL_MODULES[path] ?? fillerModule(area, name);
    }
  }
  files['README.md'] =
    '# Shop back end\n\nModules are grouped by area under `src/`: billing, catalog, orders, users, shipping and util.\n';
  return project(files);
}

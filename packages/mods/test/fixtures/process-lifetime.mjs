import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModHost } from '../../dist/index.js';

const mode = process.argv[2];
const root = await mkdtemp(join(tmpdir(), 'mod-process-lifetime-'));
const seen = [];
const marker = join(root, 'terminated');
let host;
try {
  await writeFile(
    join(root, 'chimera-mod.json'),
    JSON.stringify({
      name: 'process-lifetime',
      version: '1',
      apiVersion: 1,
      module: 'index.mjs',
    }),
  );
  const helper =
    mode === 'epipe'
      ? "require('node:fs').closeSync(0); console.log('ready'); setTimeout(() => process.exit(0), 6000)"
      : `process.on('SIGTERM', () => {require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'terminated'); ${mode === 'stubborn' ? '' : 'process.exit(0)'}}); console.log('ready'); setTimeout(() => process.exit(0), 6000)`;
  const argv =
    mode === 'epipe'
      ? [process.execPath, '-e', helper]
      : ['sh', '-c', '"$1" -e "$2" & wait', 'helper', process.execPath, helper];
  await writeFile(
    join(root, 'index.mjs'),
    `
export function register(on) {
  on('session.start', async ($) => {
    const child = $.process.spawn({argv: ${JSON.stringify(argv)}});
    for await (const chunk of child.output) {
      if (chunk.text.includes('ready')) break;
    }
    ${
      mode === 'epipe'
        ? `try { await child.write('event'); } catch (error) { $.ui.log('rejected:' + error.code, {to:'debug'}); }
    await $.clock.sleep(20);`
        : ''
    }
  });
}
`,
  );
  host = await ModHost.create({
    folders: [root],
    envDirs: '',
    userDirectory: join(root, 'none'),
    dataDirectory: join(root, 'data'),
    sessionContext: () => ({}),
    ui: (text) => seen.push(text),
  });
  await host.observe({ type: 'session.start', sessionId: 'test', reason: 'new', name: 'test' });
  const started = Date.now();
  await host.shutdown();
  console.log(
    JSON.stringify({
      seen,
      elapsed: Date.now() - started,
      terminated: mode !== 'epipe' ? await readFile(marker, 'utf8') : undefined,
    }),
  );
} finally {
  await host?.shutdown();
  await rm(root, { recursive: true, force: true });
}

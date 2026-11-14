import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModHost } from '../../dist/index.js';

const root = await mkdtemp(join(tmpdir(), 'mod-runtime-smoke-'));
const folders = [];
for (const extension of ['mjs', 'mts']) {
  const folder = join(root, extension);
  await mkdir(folder);
  await writeFile(
    join(folder, 'chimera-mod.json'),
    JSON.stringify({
      name: extension,
      version: '1.0.0',
      apiVersion: 1,
      module: `index.${extension}`,
    }),
  );
  await writeFile(
    join(folder, `index.${extension}`),
    `export function register(on${extension === 'mts' ? ': Function' : ''}) { on('turn.complete', ($) => $.ui.log('${extension}')); }`,
  );
  folders.push(folder);
}
const seen = [];
const host = await ModHost.create({
  folders,
  envDirs: '',
  userDirectory: join(root, 'none'),
  dataDirectory: join(root, 'data'),
  sessionContext: () => ({}),
  ui: (text) => seen.push(text),
});
await host.observe({ type: 'turn.complete', sessionId: 'smoke' });
await host.shutdown();
console.log(JSON.stringify({ seen, mods: host.mods.map(({ status }) => status) }));
if (seen.join(',') !== 'mjs,mts') process.exitCode = 1;

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const declarations = await readFile(new URL('./index.d.ts', import.meta.url), 'utf8');
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await Promise.all([
  writeFile(new URL('./dist/index.d.ts', import.meta.url), declarations),
  writeFile(new URL('./dist/declarations.json', import.meta.url), JSON.stringify(declarations)),
]);

import { defineConfig } from 'tsup';
import { baseConfig } from '../../tsup.config.base';

export default defineConfig({
  ...baseConfig,
  entry: ['src/index.ts'],
  // The Dockerfile and entrypoint ship inside the code: a single binary has no docker/ directory.
  esbuildPlugins: [
    {
      name: 'sandbox-build-context-as-text',
      setup(build) {
        build.onLoad({ filter: /docker[/\\](Dockerfile|entrypoint\.sh)$/ }, async ({ path }) => {
          const { readFile } = await import('node:fs/promises');
          return { contents: await readFile(path, 'utf8'), loader: 'text' };
        });
      },
    },
  ],
});

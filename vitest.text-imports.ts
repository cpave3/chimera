import type { Plugin } from 'vite';

/**
 * Import files as their text, as the tsup text loader does for a build: the
 * built-in modes, skills and agents (`.md`), and the sandbox's Dockerfile
 * and entrypoint, load the same way in tests.
 */
export function textImports(pattern: RegExp = /\.md$/): Plugin {
  return {
    name: 'chimera-text-imports',
    enforce: 'pre',
    transform(code, id) {
      if (!pattern.test(id)) return undefined;
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}

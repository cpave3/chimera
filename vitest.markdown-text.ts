import type { Plugin } from 'vite';

/**
 * Import `.md` files as their text, as tsup's `.md: text` loader does for a
 * build, so built-in modes, skills and agents load the same way in tests.
 */
export function markdownAsText(): Plugin {
  return {
    name: 'chimera-markdown-as-text',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.md')) return undefined;
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}

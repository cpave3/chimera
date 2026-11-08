// Preloaded with `node --import` ahead of dist/bin.js. On exit it prints, as
// one JSON line on stderr, which React builds were loaded and the NODE_ENV
// that child processes (the bash tool, hooks) would inherit.
import Module from 'node:module';

process.on('exit', () => {
  // Node's ESM loader also caches, unevaluated, every reexport target it
  // pre-parses (both branches of react/index.js), so count only loaded ones.
  const reactBuilds = Object.entries(Module._cache)
    .filter(([path, cached]) => cached.loaded && /[\\/]react[\\/]cjs[\\/]/.test(path))
    .map(([path]) => path)
    .map((path) => path.split(/[\\/]/).pop());
  process.stderr.write(
    `${JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, reactBuilds })}\n`,
  );
});

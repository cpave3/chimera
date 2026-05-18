/**
 * Default directory blocklist for glob/grep to avoid surfacing generated
 * caches, vendored deps, and build artifacts that bloat tool output.
 */
export const DEFAULT_BLOCKLIST = [
  'node_modules',
  'dist',
  '.git',
  'vendor',
  'build',
  'out',
  'target',
  '.next',
  '.cache',
  'coverage',
  'bower_components',
  'tmp',
  'temp',
  'logs',
];

/**
 * Return ripgrep --glob flags for every blocked directory,
 * unless the user explicitly disables the blocklist.
 */
export function blockedDirGlobs(noBlocklist?: boolean): string[] {
  if (noBlocklist) return [];
  return DEFAULT_BLOCKLIST.map((dir) => `!**/${dir}/**`);
}

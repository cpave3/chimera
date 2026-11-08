import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashGrammarPath } from '../src/grammar';

describe('bashGrammarPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chimera-grammar-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('takes the grammar beside the module, as a build or a single binary places it', () => {
    writeFileSync(join(dir, 'tree-sitter-bash.wasm'), '');
    expect(bashGrammarPath(dir)).toBe(join(dir, 'tree-sitter-bash.wasm'));
  });

  it('falls back to the parser package when run from source', () => {
    expect(bashGrammarPath(dir)).toMatch(/pi-safe-shell[/\\]src[/\\]tree-sitter-bash\.wasm$/);
  });
});

import { describe, expect, it } from 'vitest';
import { type PreflightChecks, preflight } from '../src/preflight';
import { resolveSelection } from '../src/selection';

const selection = resolveSelection({
  models: ['qwen3.5-9b', 'gemma-4-12b'],
  chimeraCommand: ['node', '/repo/packages/cli/dist/bin.js'],
});

function checks(overrides: Partial<PreflightChecks> = {}): PreflightChecks {
  return {
    fileExists: () => true,
    hasOsSandbox: () => true,
    serverModels: async () => ['qwen/qwen3.5-9b', 'google/gemma-4-12b-qat'],
    ...overrides,
  };
}

describe('preflight', () => {
  it('finds no problem when the binary, the sandbox, the server and the models are there', async () => {
    expect(await preflight(selection, checks())).toEqual([]);
  });

  it('says how to build a missing chimera binary', async () => {
    const problems = await preflight(selection, checks({ fileExists: () => false }));

    expect(problems).toEqual([
      'The chimera binary /repo/packages/cli/dist/bin.js does not exist. Build it with: pnpm -r build',
    ]);
  });

  it('refuses to run without the OS sandbox', async () => {
    const problems = await preflight(selection, checks({ hasOsSandbox: () => false }));

    expect(problems[0]).toMatch(/bubblewrap/);
  });

  it('says how to start a server that does not answer', async () => {
    const problems = await preflight(
      selection,
      checks({
        serverModels: async () => {
          throw new Error('fetch failed');
        },
      }),
    );

    expect(problems).toEqual([
      'No model server answers at http://127.0.0.1:1234/v1 (fetch failed). Start it with: lms server start',
    ]);
  });

  it('says how to get a model that the server does not have', async () => {
    const problems = await preflight(
      selection,
      checks({ serverModels: async () => ['qwen/qwen3.5-9b'] }),
    );

    expect(problems).toEqual([
      'The server does not have the model google/gemma-4-12b-qat. Download it with: lms get google/gemma-4-12b-qat',
    ]);
  });
});

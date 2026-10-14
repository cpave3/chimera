import { describe, expect, it } from 'vitest';
import { createModelLoader } from '../src/lmstudio';

function recordingExec() {
  const calls: string[] = [];
  const exec = async (args: string[]) => {
    calls.push(args.join(' '));
  };
  return { calls, exec };
}

describe('model loader', () => {
  it('unloads what is on the GPU and loads the model with the context length', async () => {
    const { calls, exec } = recordingExec();
    const loader = createModelLoader(exec);

    await loader.ensureLoaded('qwen/qwen3.5-9b', 32_768);

    expect(calls).toEqual([
      'unload --all',
      'load qwen/qwen3.5-9b --context-length 32768 --ttl 1800 --yes',
    ]);
  });

  it('loads a model once for runs that follow each other, also when they start together', async () => {
    const { calls, exec } = recordingExec();
    const loader = createModelLoader(exec);

    await Promise.all([
      loader.ensureLoaded('qwen/qwen3.5-9b', 32_768),
      loader.ensureLoaded('qwen/qwen3.5-9b', 32_768),
    ]);
    await loader.ensureLoaded('qwen/qwen3.5-9b', 32_768);

    expect(calls.filter((call) => call.startsWith('load'))).toHaveLength(1);
  });

  it('replaces the loaded model when the next run uses another one', async () => {
    const { calls, exec } = recordingExec();
    const loader = createModelLoader(exec);

    await loader.ensureLoaded('qwen/qwen3.5-9b', 32_768);
    await loader.ensureLoaded('google/gemma-4-12b-qat', 32_768);

    expect(calls.slice(2)).toEqual([
      'unload --all',
      'load google/gemma-4-12b-qat --context-length 32768 --ttl 1800 --yes',
    ]);
  });

  it('tries the load again after a load that failed', async () => {
    let failNext = true;
    const calls: string[] = [];
    const loader = createModelLoader(async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'load' && failNext) {
        failNext = false;
        throw new Error('out of memory');
      }
    });

    await expect(loader.ensureLoaded('qwen/qwen3.8-27b', 32_768)).rejects.toThrow('out of memory');
    await loader.ensureLoaded('qwen/qwen3.8-27b', 32_768);

    expect(calls.filter((call) => call.startsWith('load'))).toHaveLength(2);
  });
});

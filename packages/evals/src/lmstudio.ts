import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Runs the `lms` CLI with the arguments. */
export type LmsExec = (args: string[]) => Promise<void>;

export interface ModelLoader {
  /** Makes the model the one loaded model of the server. */
  ensureLoaded(modelKey: string, contextLength: number): Promise<void>;
}

// The server unloads a model that the harness left behind after a crash.
const IDLE_TTL_SECONDS = 1800;

async function lms(args: string[]): Promise<void> {
  await execFileAsync('lms', args, { timeout: 10 * 60_000 });
}

/**
 * Keeps one model on the GPU at a time. The first run of a model unloads every
 * loaded model, so the context length is the one asked for and not the one of
 * an earlier load.
 */
export function createModelLoader(exec: LmsExec = lms): ModelLoader {
  let loaded: string | undefined;
  let queue: Promise<void> = Promise.resolve();

  return {
    ensureLoaded(modelKey, contextLength) {
      const wanted = `${modelKey} ${contextLength}`;
      const next = queue.then(async () => {
        if (loaded === wanted) return;
        loaded = undefined;
        await exec(['unload', '--all']);
        await exec([
          'load',
          modelKey,
          '--context-length',
          String(contextLength),
          '--ttl',
          String(IDLE_TTL_SECONDS),
          '--yes',
        ]);
        loaded = wanted;
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}

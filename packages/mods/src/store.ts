import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ModStore {
  readonly directory: string;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createStore(directory: string): ModStore {
  const filename = (key: string) => join(directory, `${encodeURIComponent(key)}.json`);
  return {
    directory,
    async get<T>(key: string): Promise<T | undefined> {
      let content: string;
      try {
        content = await readFile(filename(key), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      return JSON.parse(content);
    },
    async set(key, value) {
      const content = JSON.stringify(value);
      if (content === undefined) throw new Error('Mod store values must be JSON serializable');
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `${randomUUID()}.tmp`);
      await writeFile(temporary, content);
      await rename(temporary, filename(key));
    },
    async delete(key) {
      try {
        await unlink(filename(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },
  };
}

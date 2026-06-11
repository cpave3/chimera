import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_TTL_DAYS = 30;

export interface RecallEntry {
  id: string;
  createdAt: number;
  toolName: string;
  argsJson: string;
  content: string;
  byteLen: number;
}

export interface RecallPutInput {
  toolName: string;
  args: unknown;
  content: string;
}

export interface RecallStoreOptions {
  sessionId: string;
  home?: string;
  ttlDays?: number;
}

/**
 * File-per-entry archive for pruned tool outputs:
 * `~/.chimera/recall/<sessionId>/<id>.json`. IDs are content-addressed
 * (`pr_` + 8 hex of SHA-256 over toolName | canonical args | content hash),
 * so re-archiving the same output is a no-op and distinct contents never
 * collide in practice; on the astronomically unlikely prefix collision with
 * different content, the id extends to 12 hex chars.
 *
 * GC: entries whose file mtime is older than `ttlDays` are unlinked lazily
 * on the first write of each store instance.
 */
export class RecallStore {
  private readonly dir: string;
  private readonly ttlMs: number;
  private gcDone = false;

  constructor(opts: RecallStoreOptions) {
    const home = opts.home ?? homedir();
    this.dir = join(home, '.chimera', 'recall', opts.sessionId);
    this.ttlMs = (opts.ttlDays ?? DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
  }

  static async removeSession(sessionId: string, home = homedir()): Promise<void> {
    await rm(join(home, '.chimera', 'recall', sessionId), { recursive: true, force: true });
  }

  async put(input: RecallPutInput): Promise<RecallEntry> {
    await mkdir(this.dir, { recursive: true });
    if (!this.gcDone) {
      this.gcDone = true;
      await this.gc();
    }
    const argsJson = canonicalJson(input.args);
    const digest = createHash('sha256')
      .update(input.toolName)
      .update('|')
      .update(argsJson)
      .update('|')
      .update(createHash('sha256').update(input.content).digest('hex'))
      .digest('hex');

    for (const idLength of [8, 12]) {
      const id = `pr_${digest.slice(0, idLength)}`;
      const existing = await this.get(id);
      if (existing) {
        if (existing.content === input.content) return existing;
        continue; // prefix collision with different content — extend
      }
      const entry: RecallEntry = {
        id,
        createdAt: Date.now(),
        toolName: input.toolName,
        argsJson,
        content: input.content,
        byteLen: Buffer.byteLength(input.content, 'utf8'),
      };
      await this.write(entry);
      return entry;
    }
    throw new Error('recall id collision at 12 hex chars — content hash space exhausted?');
  }

  async get(id: string): Promise<RecallEntry | null> {
    if (!/^pr_[0-9a-f]{8,12}$/.test(id)) return null;
    try {
      const raw = await readFile(join(this.dir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as RecallEntry;
    } catch {
      return null;
    }
  }

  private async write(entry: RecallEntry): Promise<void> {
    const path = join(this.dir, `${entry.id}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), 'utf8');
    await rename(tmp, path);
  }

  private async gc(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - this.ttlMs;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) await unlink(path);
      } catch {
        // Entry raced away — nothing to clean.
      }
    }
  }
}

/** JSON.stringify with object keys sorted recursively, for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

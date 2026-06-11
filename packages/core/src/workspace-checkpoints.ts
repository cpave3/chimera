import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SessionId } from './ids';
import type { Checkpoint } from './persistence';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export interface WorkspaceSnapshotRecord {
  /** 1-based position of the user message this snapshot precedes. */
  ordinal: number;
  commit: string;
  userMessage: string;
  ts: number;
}

interface Manifest {
  records: WorkspaceSnapshotRecord[];
}

export interface WorkspaceCheckpointsOptions {
  sessionId: SessionId;
  cwd: string;
  home?: string;
  warn?: (msg: string) => void;
}

/**
 * Shadow-git snapshots of the session's working tree, taken before each user
 * message runs, so `/rewind` can restore file state alongside conversation
 * state. The shadow repo lives under the session directory (`workspace.git`)
 * with the session cwd as its work tree; the project's own `.git` is never
 * touched. Snapshots respect the project's `.gitignore`.
 *
 * Snapshot records are keyed by (userMessage, occurrence) — the same identity
 * scheme `readCheckpoints` uses — because checkpoint indices are message
 * positions, not stable ordinals. All operations are best-effort: a missing
 * git binary or a failing command degrades to "no snapshot", never an error.
 */
export class WorkspaceCheckpoints {
  private readonly cwd: string;
  private readonly gitDir: string;
  private readonly manifestPath: string;
  private readonly warn: (msg: string) => void;

  constructor(opts: WorkspaceCheckpointsOptions) {
    const home = opts.home ?? homedir();
    this.cwd = opts.cwd;
    const sessionDir = join(home, '.chimera', 'sessions', opts.sessionId);
    this.gitDir = join(sessionDir, 'workspace.git');
    this.manifestPath = join(sessionDir, 'workspace-checkpoints.json');
    this.warn = opts.warn ?? ((msg) => process.stderr.write(`${msg}\n`));
  }

  /**
   * Snapshot the current working tree as the state preceding the next user
   * message. Returns the new record, or null when git is unavailable or the
   * snapshot fails.
   */
  async snapshot(userMessage: string): Promise<WorkspaceSnapshotRecord | null> {
    try {
      await this.ensureRepo();
      const manifest = await this.loadManifest();
      const ordinal = (manifest.records[manifest.records.length - 1]?.ordinal ?? 0) + 1;
      await this.git(['add', '-A']);
      await this.git([
        '-c',
        'user.name=chimera',
        '-c',
        'user.email=chimera@localhost',
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        `checkpoint ${ordinal}`,
      ]);
      const { stdout } = await this.git(['rev-parse', 'HEAD']);
      const record: WorkspaceSnapshotRecord = {
        ordinal,
        commit: stdout.trim(),
        userMessage,
        ts: Date.now(),
      };
      manifest.records.push(record);
      await this.saveManifest(manifest);
      return record;
    } catch (err) {
      this.warn(`workspace checkpoint failed: ${(err as Error)?.message ?? String(err)}`);
      return null;
    }
  }

  /**
   * Restore the working tree to the snapshot matching `target`. The current
   * tree is committed first, so a restore is itself recoverable from the
   * shadow repo. Records from the discarded timeline are dropped. Returns
   * false when no matching snapshot exists.
   */
  async restore(target: Checkpoint, checkpoints: Checkpoint[]): Promise<boolean> {
    let matched: WorkspaceSnapshotRecord | undefined;
    try {
      const manifest = await this.loadManifest();
      if (manifest.records.length === 0) return false;

      if (target.index === 0) {
        matched = manifest.records.find((record) => record.ordinal === 1);
      } else {
        const occurrence = countOccurrence(target, checkpoints);
        const sameMessage = manifest.records.filter(
          (record) => record.userMessage === target.userMessage,
        );
        matched = sameMessage[occurrence - 1];
      }
      if (!matched) return false;

      await this.git(['add', '-A']);
      await this.git([
        '-c',
        'user.name=chimera',
        '-c',
        'user.email=chimera@localhost',
        'commit',
        '--allow-empty',
        '--no-verify',
        '-m',
        'pre-restore safety snapshot',
      ]);
      await this.git(['reset', '--hard', matched.commit]);

      manifest.records = manifest.records.filter((record) => record.ordinal < matched!.ordinal);
      await this.saveManifest(manifest);
      return true;
    } catch (err) {
      this.warn(`workspace restore failed: ${(err as Error)?.message ?? String(err)}`);
      return false;
    }
  }

  private async ensureRepo(): Promise<void> {
    await mkdir(this.gitDir, { recursive: true });
    try {
      await this.git(['rev-parse', '--git-dir']);
    } catch {
      await this.git(['init']);
      const excludePath = join(this.gitDir, 'info', 'exclude');
      await mkdir(join(this.gitDir, 'info'), { recursive: true });
      await writeFile(excludePath, '.git\n.chimera/\nnode_modules/\n', 'utf8');
    }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('git', args, {
      cwd: this.cwd,
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_DIR: this.gitDir,
        GIT_WORK_TREE: this.cwd,
      },
    });
  }

  private async loadManifest(): Promise<Manifest> {
    try {
      const raw = await readFile(this.manifestPath, 'utf8');
      const parsed = JSON.parse(raw) as Manifest;
      return { records: Array.isArray(parsed.records) ? parsed.records : [] };
    } catch {
      return { records: [] };
    }
  }

  private async saveManifest(manifest: Manifest): Promise<void> {
    const tmp = `${this.manifestPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
    await rename(tmp, this.manifestPath);
  }
}

/**
 * Occurrence of `target.userMessage` among the checkpoints up to and
 * including `target`, matching the chronological order both lists share.
 */
function countOccurrence(target: Checkpoint, checkpoints: Checkpoint[]): number {
  let occurrence = 0;
  for (const candidate of checkpoints) {
    if (candidate.index === 0) continue;
    if (candidate.userMessage === target.userMessage) occurrence += 1;
    if (candidate.index === target.index) break;
  }
  return occurrence;
}

import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PersistedEvent } from './events';
import { newSessionId, type SessionId } from './ids';
import {
  DEFAULT_SESSION_MODE,
  emptyUsage,
  type ModelConfig,
  type SandboxMode,
  type Session,
  type Usage,
} from './types';

export function sessionsDir(home = homedir()): string {
  return join(home, '.chimera', 'sessions');
}

export function sessionDir(sessionId: SessionId, home = homedir()): string {
  return join(sessionsDir(home), sessionId);
}

export function sessionMetadataPath(sessionId: SessionId, home = homedir()): string {
  return join(sessionDir(sessionId, home), 'session.json');
}

export function sessionEventsPath(sessionId: SessionId, home = homedir()): string {
  return join(sessionDir(sessionId, home), 'events.jsonl');
}

interface SessionMetadata {
  id: SessionId;
  parentId: SessionId | null;
  children: SessionId[];
  cwd: string;
  createdAt: number;
  model: ModelConfig;
  sandboxMode: SandboxMode;
  usage: Usage;
  mode: string;
  userModelOverride: string | null;
  /** Sorted arrays derived from fileOps Sets for JSON serialisation */
  fileOpsReads?: string[];
  fileOpsWrites?: string[];
  /** Cached message count so listings avoid reading events.jsonl. */
  messageCount?: number;
  /** Additional read/write allow paths for tool calls outside cwd. */
  additionalReadPaths?: string[];
  additionalWritePaths?: string[];
}

function toMetadata(session: Session): SessionMetadata {
  return {
    id: session.id,
    parentId: session.parentId,
    children: session.children,
    cwd: session.cwd,
    createdAt: session.createdAt,
    model: session.model,
    sandboxMode: session.sandboxMode,
    usage: session.usage,
    mode: session.mode,
    userModelOverride: session.userModelOverride,
    fileOpsReads: sortedArray(session.fileOps.reads),
    fileOpsWrites: sortedArray(session.fileOps.writes),
    messageCount: session.messages.length,
    additionalReadPaths: session.additionalReadPaths,
    additionalWritePaths: session.additionalWritePaths,
  };
}

function sortedArray(set: Set<string>): string[] {
  return Array.from(set).sort();
}

let tmpCounter = 0;

export async function writeSessionMetadata(session: Session, home = homedir()): Promise<void> {
  const path = sessionMetadataPath(session.id, home);
  await mkdir(dirname(path), { recursive: true });
  // Per-call counter prevents tmp-name collisions when multiple writes
  // happen in the same millisecond from the same process.
  tmpCounter += 1;
  const tmp = `${path}.${process.pid}.${Date.now()}.${tmpCounter}.tmp`;
  await writeFile(tmp, JSON.stringify(toMetadata(session), null, 2), 'utf8');
  await rename(tmp, path);
}

async function ensureSessionDir(sessionId: SessionId, home: string): Promise<void> {
  await mkdir(sessionDir(sessionId, home), { recursive: true });
}

export async function appendSessionEvent(
  sessionId: SessionId,
  event: PersistedEvent,
  home = homedir(),
): Promise<void> {
  await ensureSessionDir(sessionId, home);
  const path = sessionEventsPath(sessionId, home);
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
}

// The two writes touch different files (append vs atomic tmp+rename) and
// are independent, so they run concurrently.
export async function persistSession(
  session: Session,
  event: PersistedEvent,
  home = homedir(),
): Promise<void> {
  await ensureSessionDir(session.id, home);
  await Promise.all([
    appendSessionEvent(session.id, event, home),
    writeSessionMetadata(session, home),
  ]);
}

export async function loadSession(sessionId: SessionId, home = homedir()): Promise<Session> {
  const metaPath = sessionMetadataPath(sessionId, home);
  const raw = await readFile(metaPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<SessionMetadata> & {
    messages?: unknown;
    toolCalls?: unknown;
  };
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid session metadata: ${metaPath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id !== sessionId) {
    throw new Error(`Session id mismatch in ${metaPath}`);
  }

  const session: Session = {
    id: sessionId,
    parentId: typeof parsed.parentId === 'string' ? parsed.parentId : null,
    children: Array.isArray(parsed.children) ? (parsed.children as SessionId[]) : [],
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    messages: [],
    toolCalls: [],
    status: 'idle',
    model: (parsed.model as ModelConfig) ?? {
      providerId: 'unknown',
      modelId: 'unknown',
      maxSteps: 100,
    },
    sandboxMode: (parsed.sandboxMode as SandboxMode) ?? 'off',
    usage:
      parsed.usage && typeof parsed.usage === 'object' ? (parsed.usage as Usage) : emptyUsage(),
    mode:
      typeof parsed.mode === 'string' && parsed.mode.length > 0
        ? parsed.mode
        : DEFAULT_SESSION_MODE,
    userModelOverride:
      typeof parsed.userModelOverride === 'string' ? parsed.userModelOverride : null,
    fileOps: {
      reads: new Set(Array.isArray(parsed.fileOpsReads) ? parsed.fileOpsReads : []),
      writes: new Set(Array.isArray(parsed.fileOpsWrites) ? parsed.fileOpsWrites : []),
    },
    additionalReadPaths: Array.isArray(parsed.additionalReadPaths) ? parsed.additionalReadPaths : [],
    additionalWritePaths: Array.isArray(parsed.additionalWritePaths)
      ? parsed.additionalWritePaths
      : [],
  };

  const snapshot = await readLatestStepSnapshot(sessionId, home);
  if (snapshot) {
    session.messages = snapshot.messages;
    session.toolCalls = snapshot.toolCalls;
    session.usage = snapshot.usage;
  }

  return session;
}

export interface SessionMetadataReadResult {
  id: SessionId;
  cwd: string;
  model: ModelConfig;
  sandboxMode: SandboxMode;
  parentId: SessionId | null;
  children: SessionId[];
  createdAt: number;
  usage: Usage;
  mode: string;
  userModelOverride: string | null;
  messageCount: number;
  /** Additional read/write allow paths persisted in session metadata. */
  additionalReadPaths: string[];
  additionalWritePaths: string[];
}

/**
 * Read and validate session.json for a known session id.
 * Throws on ENOENT or malformed data; callers catch and map to 404.
 */
export async function readSessionMetadata(
  sessionId: SessionId,
  home = homedir(),
): Promise<SessionMetadataReadResult> {
  const metaPath = sessionMetadataPath(sessionId, home);
  const raw = await readFile(metaPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<SessionMetadata> & {
    messages?: unknown;
    toolCalls?: unknown;
  };
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid session metadata: ${metaPath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id !== sessionId) {
    throw new Error(`Session id mismatch in ${metaPath}`);
  }

  const messageCount =
    typeof parsed.messageCount === 'number'
      ? parsed.messageCount
      : await countLatestMessageCount(sessionId, home);

  return {
    id: sessionId,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
    model: (parsed.model as ModelConfig) ?? {
      providerId: 'unknown',
      modelId: 'unknown',
      maxSteps: 100,
    },
    sandboxMode: (parsed.sandboxMode as SandboxMode) ?? 'off',
    parentId: typeof parsed.parentId === 'string' ? parsed.parentId : null,
    children: Array.isArray(parsed.children) ? (parsed.children as SessionId[]) : [],
    createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    usage:
      parsed.usage && typeof parsed.usage === 'object' ? (parsed.usage as Usage) : emptyUsage(),
    mode:
      typeof parsed.mode === 'string' && parsed.mode.length > 0
        ? parsed.mode
        : DEFAULT_SESSION_MODE,
    userModelOverride:
      typeof parsed.userModelOverride === 'string' ? parsed.userModelOverride : null,
    messageCount,
    additionalReadPaths: Array.isArray(parsed.additionalReadPaths) ? parsed.additionalReadPaths : [],
    additionalWritePaths: Array.isArray(parsed.additionalWritePaths)
      ? parsed.additionalWritePaths
      : [],
  };
}

interface StepSnapshot {
  messages: Session['messages'];
  toolCalls: Session['toolCalls'];
  usage: Usage;
}

const CHUNK_SIZE = 64 * 1024;

async function readLatestStepSnapshot(
  sessionId: SessionId,
  home: string,
): Promise<StepSnapshot | null> {
  const path = sessionEventsPath(sessionId, home);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(path);
    if (stats.size === 0) return null;
    handle = await open(path, 'r');
  } catch {
    return null;
  }

  let chunkSize = Math.min(CHUNK_SIZE, stats.size);
  let position = stats.size;

  try {
    while (true) {
      position = Math.max(0, position - chunkSize);
      const actualChunkSize = position === 0 ? stats.size - position : chunkSize;
      const buffer = Buffer.alloc(actualChunkSize);
      const { bytesRead } = await handle.read(buffer, 0, actualChunkSize, position);
      const chunk = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');

      // If this is not the first chunk, the first line is a fragment (the
      // rest of the line lives in the preceding chunk). Skip it.
      const skipFirst = position > 0;
      const start = skipFirst ? 1 : 0;
      const isLastChunk = position + bytesRead >= stats.size;

      let latest: StepSnapshot | null = null;
      for (let i = lines.length - 1; i >= start; i--) {
        const line = lines[i];
        if (!line) continue;
        let parsed: PersistedEvent;
        try {
          parsed = JSON.parse(line) as PersistedEvent;
        } catch {
          // When reading from the tail of the file, warn for any malformed
          // line so data corruption near the end is still visible.
          if (isLastChunk) {
            process.stderr.write(
              `[chimera] warn: skipping malformed line in ${path}\n`,
            );
          }
          continue;
        }
        if (parsed && (parsed.type === 'step_finished' || parsed.type === 'message_appended')) {
          latest = {
            messages: parsed.messages,
            toolCalls: parsed.toolCalls,
            usage: parsed.usage,
          };
          break;
        }
      }
      if (latest) return latest;
      if (position === 0) return null;
      // Snapshot might span chunk boundary; double chunk and retry.
      chunkSize = Math.min(chunkSize * 2, stats.size);
    }
  } finally {
    await handle?.close();
  }
}

async function countLines(path: string): Promise<number> {
  try {
    const raw = await readFile(path, 'utf8');
    if (raw.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) === 10) count += 1;
    }
    if (raw.charCodeAt(raw.length - 1) !== 10) count += 1;
    return count;
  } catch (err) {
    console.debug(
      `[persistence] countLines(${path}):`,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

export interface ForkOptions {
  parentId: SessionId;
  purpose?: string;
  home?: string;
}

export interface ForkResult {
  session: Session;
  childId: SessionId;
}

export async function forkSession(opts: ForkOptions): Promise<ForkResult> {
  const home = opts.home ?? homedir();
  const parent = await loadSession(opts.parentId, home);
  const childId = newSessionId();
  await ensureSessionDir(childId, home);

  const parentEvents = sessionEventsPath(opts.parentId, home);
  const childEvents = sessionEventsPath(childId, home);
  let parentEventCount = 0;
  try {
    await copyFile(parentEvents, childEvents);
    parentEventCount = await countLines(childEvents);
  } catch (err) {
    // ENOENT: parent had no events.jsonl yet; child starts empty.
    // Anything else (EACCES, ENOSPC, ...) is a real failure — surface it.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const forkedFrom: PersistedEvent = {
    type: 'forked_from',
    parentId: opts.parentId,
    parentEventCount,
    ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
  };
  await appendSessionEvent(childId, forkedFrom, home);

  const child: Session = {
    id: childId,
    parentId: opts.parentId,
    children: [],
    cwd: parent.cwd,
    createdAt: Date.now(),
    messages: parent.messages,
    toolCalls: parent.toolCalls,
    status: 'idle',
    model: parent.model,
    sandboxMode: parent.sandboxMode,
    usage: emptyUsage(),
    // Don't inherit parent's mode — per add-modes design D10, children
    // start in `build` so a plan-mode parent doesn't silently impose a
    // read-only allowlist on its child.
    mode: DEFAULT_SESSION_MODE,
    userModelOverride: null,
    fileOps: {
      reads: new Set(parent.fileOps.reads),
      writes: new Set(parent.fileOps.writes),
    },
    additionalReadPaths: [...parent.additionalReadPaths],
    additionalWritePaths: [...parent.additionalWritePaths],
  };
  await writeSessionMetadata(child, home);

  parent.children = [...parent.children, childId];
  await writeSessionMetadata(parent, home);

  return { session: child, childId };
}

export interface SessionInfo {
  id: SessionId;
  parentId: SessionId | null;
  children: SessionId[];
  createdAt: number;
  /**
   * Most recent persisted-event mtime for this session, in ms. Falls back to
   * `createdAt` when no events have been written yet. Used by `chimera
   * --continue` to pick the most-recently-active session in a directory.
   */
  lastActivityAt: number;
  cwd: string;
  model: ModelConfig;
  sandboxMode: SandboxMode;
  usage: Usage;
  messageCount: number;
  /** Additional read/write allow paths persisted in session metadata. */
  additionalReadPaths: string[];
  additionalWritePaths: string[];
}

// Pre-change flat `<id>.json` files (siblings of session directories from
// the previous persistence layout) are ignored, not migrated.
export async function listSessionsOnDisk(home = homedir()): Promise<SessionInfo[]> {
  const dir = sessionsDir(home);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    console.debug(
      `[persistence] listSessionsOnDisk readdir failed:`,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
  const out: SessionInfo[] = [];
  for (const name of entries) {
    const entryPath = join(dir, name);
    let isDir = false;
    try {
      const st = await stat(entryPath);
      isDir = st.isDirectory();
    } catch (err) {
      console.debug(
        `[persistence] listSessionsOnDisk stat(${entryPath}):`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (!isDir) continue;
    const metaPath = join(entryPath, 'session.json');
    try {
      const raw = await readFile(metaPath, 'utf8');
      const parsed = JSON.parse(raw) as SessionMetadata;
      if (!parsed || typeof parsed !== 'object' || parsed.id !== name) {
        continue;
      }
      const messageCount =
        typeof parsed.messageCount === 'number'
          ? parsed.messageCount
          : await countLatestMessageCount(name, home);
      let lastActivityAt = parsed.createdAt;
      try {
        const evStat = await stat(sessionEventsPath(name, home));
        lastActivityAt = Math.max(lastActivityAt, evStat.mtimeMs);
      } catch {
        // events.jsonl missing → keep createdAt
      }
      out.push({
        id: parsed.id,
        parentId: parsed.parentId ?? null,
        children: parsed.children ?? [],
        createdAt: parsed.createdAt,
        lastActivityAt,
        cwd: parsed.cwd,
        model: parsed.model,
        sandboxMode: parsed.sandboxMode,
        usage: parsed.usage ?? emptyUsage(),
        messageCount,
        additionalReadPaths: Array.isArray(parsed.additionalReadPaths)
          ? parsed.additionalReadPaths
          : [],
        additionalWritePaths: Array.isArray(parsed.additionalWritePaths)
          ? parsed.additionalWritePaths
          : [],
      });
    } catch (err) {
      // skip corrupt/missing session.json
      console.debug(
        `[persistence] listSessionsOnDisk metadata read(${metaPath}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return out;
}

async function countLatestMessageCount(sessionId: SessionId, home: string): Promise<number> {
  const snap = await readLatestStepSnapshot(sessionId, home);
  return snap ? snap.messages.length : 0;
}

export async function deleteSession(sessionId: SessionId, home = homedir()): Promise<void> {
  await rm(sessionDir(sessionId, home), { recursive: true, force: true });
}

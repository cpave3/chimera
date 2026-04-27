import {
  appendFile,
  copyFile,
  mkdir,
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
  };
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
  await appendFile(path, JSON.stringify(event) + '\n', 'utf8');
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
  };

  const snapshot = await readLatestStepSnapshot(sessionId, home);
  if (snapshot) {
    session.messages = snapshot.messages;
    session.toolCalls = snapshot.toolCalls;
    session.usage = snapshot.usage;
  }

  return session;
}

interface StepSnapshot {
  messages: Session['messages'];
  toolCalls: Session['toolCalls'];
  usage: Usage;
}

async function readLatestStepSnapshot(
  sessionId: SessionId,
  home: string,
): Promise<StepSnapshot | null> {
  const path = sessionEventsPath(sessionId, home);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  let latest: StepSnapshot | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let parsed: PersistedEvent;
    try {
      parsed = JSON.parse(line) as PersistedEvent;
    } catch {
      const isLast = i === lines.length - 1;
      const where = `${path}:${i + 1}`;
      if (isLast) {
        process.stderr.write(`[chimera] warn: skipping malformed trailing line at ${where}\n`);
      } else {
        process.stderr.write(`[chimera] warn: skipping malformed line at ${where}\n`);
      }
      continue;
    }
    if (parsed && parsed.type === 'step_finished') {
      latest = {
        messages: parsed.messages,
        toolCalls: parsed.toolCalls,
        usage: parsed.usage,
      };
    }
  }
  return latest;
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
  } catch {
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
}

// Pre-change flat `<id>.json` files (siblings of session directories from
// the previous persistence layout) are ignored, not migrated.
export async function listSessionsOnDisk(home = homedir()): Promise<SessionInfo[]> {
  const dir = sessionsDir(home);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const name of entries) {
    const entryPath = join(dir, name);
    let isDir = false;
    try {
      const st = await stat(entryPath);
      isDir = st.isDirectory();
    } catch {
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
      const messageCount = await countLatestMessageCount(name, home);
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
      });
    } catch {
      // skip corrupt/missing session.json
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

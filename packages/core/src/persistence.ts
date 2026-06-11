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
  truncate,
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
  type TaskItem,
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
  /** Model-maintained task list (task_list tool). */
  tasks?: TaskItem[];
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
    tasks: session.tasks,
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
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
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

export interface Checkpoint {
  index: number;
  userMessage: string;
  toolCallSummary: string;
  truncateByteOffset: number;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = (content as Array<{ type?: string; text?: string }>).filter(
      (part) => part && typeof part === 'object' && part.type === 'text',
    );
    return textParts.map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function extractPathFromArgs(args: unknown): string | undefined {
  if (
    args &&
    typeof args === 'object' &&
    'path' in args &&
    typeof (args as { path: unknown }).path === 'string'
  ) {
    return (args as { path: string }).path;
  }
  return undefined;
}

function extractToolCallSummary(
  messages: Session['messages'],
  startIndex: number,
  endIndex: number,
): string {
  const toolCalls: { name: string; path?: string }[] = [];
  for (let i = startIndex + 1; i < endIndex; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const parts = Array.isArray(msg.content) ? msg.content : [];
    for (const part of parts) {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        (part as { type?: string }).type === 'tool-call'
      ) {
        const name = ((part as { toolName?: string }).toolName as string) ?? 'tool';
        const args = (part as { input?: unknown }).input ?? (part as { args?: unknown }).args;
        const path = extractPathFromArgs(args);
        toolCalls.push({ name, path });
      }
    }
  }

  if (toolCalls.length === 0) return '';

  const counts = new Map<string, number>();
  const paths = new Map<string, Set<string>>();
  for (const tc of toolCalls) {
    counts.set(tc.name, (counts.get(tc.name) ?? 0) + 1);
    if (tc.path) {
      const set = paths.get(tc.name) ?? new Set<string>();
      set.add(tc.path);
      paths.set(tc.name, set);
    }
  }

  const parts: string[] = [];
  for (const [name, count] of counts) {
    const pathSet = paths.get(name);
    if (pathSet && pathSet.size > 0) {
      const pathList = Array.from(pathSet).join(', ');
      if (count === 1) {
        parts.push(`${name}(${pathList})`);
      } else {
        parts.push(`${name}(${pathList}) x${count}`);
      }
    } else if (count === 1) {
      parts.push(name);
    } else {
      parts.push(`${name} x${count}`);
    }
  }

  return parts.join(', ');
}

export async function readCheckpoints(sessionId: SessionId, home = homedir()): Promise<Checkpoint[]> {
  const checkpoints: Checkpoint[] = [];
  const path = sessionEventsPath(sessionId, home);

  // Always emit checkpoint 0 as the first entry — represents "before any user message".
  checkpoints.push({ index: 0, userMessage: '', toolCallSummary: '', truncateByteOffset: 0 });

  let content: string;
  try {
    const buf = await readFile(path);
    if (buf.length === 0) return checkpoints;
    content = buf.toString('utf8');
  } catch {
    return checkpoints;
  }

  // Pass 1: collect every snapshot with its end byte offset.
  interface Snapshot {
    messages: Session['messages'];
    endByteOffset: number;
  }
  const snapshots: Snapshot[] = [];
  const lines = content.split('\n');
  let currentByteOffset = 0;

  for (const line of lines) {
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    if (!line.trim()) {
      currentByteOffset += lineByteLen;
      continue;
    }
    let parsed: PersistedEvent;
    try {
      parsed = JSON.parse(line) as PersistedEvent;
    } catch {
      currentByteOffset += lineByteLen;
      continue;
    }
    if (parsed.type !== 'step_finished' && parsed.type !== 'message_appended') {
      currentByteOffset += lineByteLen;
      continue;
    }
    // endByteOffset is the byte position AFTER this snapshot line.
    snapshots.push({ messages: parsed.messages, endByteOffset: currentByteOffset + lineByteLen });
    currentByteOffset += lineByteLen;
  }

  if (snapshots.length === 0) return checkpoints;

  // Detect compaction: a snapshot with fewer messages than its predecessor.
  for (let i = 1; i < snapshots.length; i++) {
    if (snapshots[i]!.messages.length < snapshots[i - 1]!.messages.length) {
      console.warn(
        `[chimera] warn: session compaction detected for ${sessionId}; some checkpoints may be unavailable`,
      );
      break;
    }
  }

  // Pass 2: walk snapshots chronologically, tracking newly-appearing user messages.
  // A user-message identity is (content, occurrenceCount) to handle duplicates.
  interface UserIdentity {
    content: string;
    occurrence: number;
    truncateByteOffset: number;
  }
  const newlyAppearing: UserIdentity[] = [];
  const globalCounts = new Map<string, number>();

  for (let snapshotIdx = 0; snapshotIdx < snapshots.length; snapshotIdx++) {
    const snapshot = snapshots[snapshotIdx]!;
    const priorEndByteOffset = snapshotIdx > 0 ? snapshots[snapshotIdx - 1]!.endByteOffset : 0;
    const localCounts = new Map<string, number>();

    for (const msg of snapshot.messages) {
      if (msg.role === 'user') {
        const content = extractText(msg.content);
        localCounts.set(content, (localCounts.get(content) ?? 0) + 1);
      }
    }

    for (const [content, localCount] of localCounts) {
      const globalCount = globalCounts.get(content) ?? 0;
      const newCount = localCount - globalCount;
      for (let k = 0; k < newCount; k++) {
        newlyAppearing.push({
          content,
          occurrence: globalCount + k + 1,
          truncateByteOffset: priorEndByteOffset,
        });
      }
    }

    for (const [content, localCount] of localCounts) {
      globalCounts.set(content, localCount);
    }
  }

  // Pass 3: map each newly-appearing user message to the latest snapshot.
  const latest = snapshots[snapshots.length - 1]!;
  const latestUserPositions: number[] = [];
  const latestOccurrences = new Map<string, number>();
  const latestUsers: { content: string; occurrence: number; pos: number }[] = [];

  for (let pos = 0; pos < latest.messages.length; pos++) {
    const msg = latest.messages[pos]!;
    if (msg.role === 'user') {
      const content = extractText(msg.content);
      const count = (latestOccurrences.get(content) ?? 0) + 1;
      latestOccurrences.set(content, count);
      latestUserPositions.push(pos);
      latestUsers.push({ content, occurrence: count, pos });
    }
  }

  const matched = new Set<number>();
  for (const entry of newlyAppearing) {
    const foundIdx = latestUsers.findIndex(
      (u, idx) =>
        !matched.has(idx) && u.content === entry.content && u.occurrence === entry.occurrence,
    );

    if (foundIdx === -1) {
      console.warn(
        `[chimera] warn: checkpoint user message was compacted out and is no longer addressable`,
      );
      continue;
    }

    matched.add(foundIdx);
    const found = latestUsers[foundIdx]!;
    const nextUserPos = latestUsers[foundIdx + 1]?.pos ?? latest.messages.length;

    checkpoints.push({
      index: found.pos,
      userMessage: found.content,
      toolCallSummary: extractToolCallSummary(latest.messages, found.pos, nextUserPos),
      truncateByteOffset: entry.truncateByteOffset,
    });
  }

  return checkpoints;
}

export interface TruncateResult {
  messages: Session['messages'];
  toolCalls: Session['toolCalls'];
  usage: Usage;
}

export async function truncateEventsAtIndex(
  sessionId: SessionId,
  index: number,
  home = homedir(),
): Promise<TruncateResult> {
  const checkpoints = await readCheckpoints(sessionId, home);
  const checkpoint = checkpoints.find((c) => c.index === index);
  if (!checkpoint) {
    throw new Error(`Checkpoint with index ${index} not found for session ${sessionId}`);
  }

  const eventsPath = sessionEventsPath(sessionId, home);

  if (checkpoint.truncateByteOffset === 0) {
    await writeFile(eventsPath, '', 'utf8');
  } else {
    await truncate(eventsPath, checkpoint.truncateByteOffset);
  }

  const snapshot = await readLatestStepSnapshot(sessionId, home);
  if (!snapshot) {
    return { messages: [], toolCalls: [], usage: emptyUsage() };
  }
  return { messages: snapshot.messages, toolCalls: snapshot.toolCalls, usage: snapshot.usage };
}

export interface ForkOptions {
  parentId: SessionId;
  purpose?: string;
  home?: string;
  rewindIndex?: number;
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

  let snapshot: StepSnapshot | null = null;
  if (opts.rewindIndex !== undefined) {
    const result = await truncateEventsAtIndex(childId, opts.rewindIndex, home);
    snapshot = { messages: result.messages, toolCalls: result.toolCalls, usage: result.usage };
  }

  // Re-count after truncation (and before forked_from) so the recorded
  // parentEventCount reflects what the child actually inherited.
  parentEventCount = await countLines(childEvents);

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
    messages: snapshot ? snapshot.messages : parent.messages,
    toolCalls: snapshot ? snapshot.toolCalls : parent.toolCalls,
    status: 'idle',
    model: parent.model,
    sandboxMode: parent.sandboxMode,
    usage: snapshot ? snapshot.usage : emptyUsage(),
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
    tasks: [...parent.tasks],
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
  // Sibling per-session state stores. Core owns the ~/.chimera layout, so
  // it removes them by path rather than importing the owning packages.
  await rm(join(home, '.chimera', 'recall', sessionId), { recursive: true, force: true });
}

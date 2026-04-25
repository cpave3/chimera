import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SessionId } from './ids';
import { emptyUsage, type Session } from './types';

export function sessionsDir(home = homedir()): string {
  return join(home, '.chimera', 'sessions');
}

export function sessionPath(sessionId: SessionId, home = homedir()): string {
  return join(sessionsDir(home), `${sessionId}.json`);
}

export async function persistSession(session: Session, home = homedir()): Promise<void> {
  const path = sessionPath(session.id, home);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
  await rename(tmp, path);
}

export async function loadSession(sessionId: SessionId, home = homedir()): Promise<Session> {
  const path = sessionPath(sessionId, home);
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as Session;
  // Basic shape validation.
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid session file: ${path}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id !== sessionId) {
    throw new Error(`Session id mismatch in ${path}`);
  }
  if (!Array.isArray(parsed.messages)) parsed.messages = [];
  if (!Array.isArray(parsed.toolCalls)) parsed.toolCalls = [];
  if (!parsed.usage || typeof parsed.usage !== 'object') {
    parsed.usage = emptyUsage();
  }
  parsed.status = 'idle';
  return parsed;
}

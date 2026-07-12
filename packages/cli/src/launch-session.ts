import { createInterface } from 'node:readline/promises';
import { type ChimeraClient, ChimeraHttpError, type CreateSessionOpts } from '@chimera/client';

export type SessionExistsPolicy = 'resume' | 'new' | 'error';

function isSessionIdCollision(error: unknown): error is ChimeraHttpError {
  return (
    error instanceof ChimeraHttpError &&
    error.status === 409 &&
    (error.body as { code?: string } | null)?.code === 'SESSION_ID_EXISTS'
  );
}

type SessionClient = Pick<ChimeraClient, 'createSession' | 'resumeSession'>;

export interface LaunchSessionOptions {
  resumeSessionId?: string;
  sessionExists?: SessionExistsPolicy;
  isTTY?: boolean;
  prompt?: () => Promise<'resume' | 'new'>;
}

export async function launchSession(
  client: SessionClient,
  createOptions: CreateSessionOpts,
  options: LaunchSessionOptions = {},
): Promise<{ sessionId: string }> {
  if (options.resumeSessionId) return client.resumeSession(options.resumeSessionId);
  try {
    return await client.createSession(createOptions);
  } catch (error) {
    if (!isSessionIdCollision(error) || !createOptions.requestedSessionId) throw error;

    let policy = options.sessionExists;
    if (!policy && (options.isTTY ?? process.stdin.isTTY)) {
      policy = await (options.prompt ?? promptForCollision)(createOptions.requestedSessionId);
    }
    policy ??= 'error';
    if (policy === 'resume') return client.resumeSession(createOptions.requestedSessionId);
    if (policy === 'new') {
      return client.createSession({ ...createOptions, requestedSessionId: undefined });
    }
    throw error;
  }
}

async function promptForCollision(sessionId: string): Promise<'resume' | 'new'> {
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = (
        await readline.question(
          `Session ${sessionId} already exists. Resume it or create a new session? [resume/new] `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === 'resume' || answer === 'r') return 'resume';
      if (answer === 'new' || answer === 'n') return 'new';
    }
  } finally {
    readline.close();
  }
}

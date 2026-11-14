import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEventEnvelope,
  deleteSession as coreDeleteSession,
  forkSession as coreForkSession,
  isValidSessionId,
  listSessionsOnDisk,
  readCheckpoints,
  readSessionMetadata,
  type SessionId,
  type SessionInfo,
  truncateEventsAtIndex,
  WorkspaceCheckpoints,
  writeSessionMetadata,
} from '@chimera/core';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AgentRegistry } from './agent-registry';

export interface AppOptions {
  registry: AgentRegistry;
  secret?: string;
  /** Home directory for session persistence; defaults to os.homedir(). */
  home?: string;
  /**
   * Hook fired when a session is forked. Lets the caller (e.g. the CLI)
   * perform side effects beyond core's metadata copy — notably, copying the
   * parent's overlay upperdir for `overlay`-mode sandboxes.
   */
  onFork?: (parentInfo: SessionInfo, childId: SessionId) => Promise<void> | void;
}

const settingsSchema = z
  .object({
    thinking: z.enum(['on', 'off', 'adaptive']).optional(),
    reasoningEffort: z.string().optional(),
    thinkingBudgetTokens: z.number().int().positive().optional(),
    reasoningSummary: z.string().optional(),
    verbosity: z.string().optional(),
    serviceTier: z.string().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    parallelToolCalls: z.boolean().optional(),
  })
  .strict();

const settingsPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(settingsSchema.shape).map(([key, schema]) => [key, schema.nullable()]),
    ),
  )
  .strict();

const createSessionSchema = z.object({
  cwd: z.string(),
  model: z.object({
    providerId: z.string(),
    modelId: z.string(),
    maxSteps: z.number(),
    maxOutputTokens: z.number().optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    settings: settingsSchema.optional(),
    parallelToolCalls: z.boolean().optional(),
    vision: z.boolean().optional(),
    imageLongEdge: z.number().optional(),
    toolCallShape: z.enum(['chimera', 'codex']).optional(),
  }),
  sandboxMode: z.enum(['off', 'bind', 'overlay', 'ephemeral']).optional(),
  name: z.string().optional(),
  requestedSessionId: z.string().optional(),
  additionalReadPaths: z.array(z.string()).optional(),
  additionalWritePaths: z.array(z.string()).optional(),
});

const messageSchema = z.object({
  content: z.string(),
  images: z.array(z.string()).optional(),
});

const forkSchema = z.object({
  purpose: z.string().optional(),
  rewindIndex: z.number().int().nonnegative().optional(),
});

const rewindSchema = z.object({
  index: z.number().int().nonnegative(),
});

const reloadSchema = z.object({
  systemPrompt: z.string().optional(),
});

const modeSchema = z.object({
  mode: z.string(),
});

const goalSchema = z.object({
  condition: z.string().trim().min(1).nullable(),
});

const modelSchema = z
  .object({
    model: z.string().nullable().optional(),
    settings: settingsPatchSchema.optional(),
    resetSettings: z.boolean().optional(),
    expectedModel: z.string().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.model !== undefined || value.settings !== undefined || value.resetSettings === true,
    'A model or settings change is required',
  );

const pathsAddSchema = z.object({
  kind: z.enum(['read', 'write']),
  path: z.string(),
});

const permissionRuleSchema = z.object({
  rule: z.object({
    tool: z.string(),
    target: z.enum(['host', 'sandbox']),
    pattern: z.string(),
    patternKind: z.enum(['exact', 'glob', 'prefix']),
    allowUnsandboxed: z.boolean().optional(),
    decision: z.enum(['allow', 'deny']),
    createdAt: z.number(),
  }),
  scope: z.enum(['session', 'project', 'global']),
});

const rememberSchema = z.object({
  scope: z.enum(['session', 'project', 'global']),
  pattern: z.string(),
  patternKind: z.enum(['exact', 'glob', 'prefix']),
  allowUnsandboxed: z.boolean().optional(),
});
const questionResolutionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('answered'),
    answers: z
      .array(z.object({ question: z.string(), answer: z.string(), custom: z.boolean() }))
      .min(1),
  }),
  z.object({ status: z.literal('cancelled') }),
]);
const permissionResolveSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('allow'), remember: rememberSchema.optional() }),
  z.object({
    decision: z.literal('allow_with_grant'),
    grant: z.object({ id: z.string(), kind: z.enum(['read', 'write']), path: z.string() }),
  }),
  z.object({ decision: z.literal('deny'), feedback: z.string().trim().min(1).optional() }),
]);

export function buildApp(opts: AppOptions): Hono {
  const { registry, home, onFork } = opts;
  // Match the encoded secret literally, rather than letting Hono decode routing metacharacters.
  const root = new Hono(
    opts.secret ? { getPath: (request) => new URL(request.url).pathname } : undefined,
  );
  const app = new Hono().basePath(
    opts.secret ? `/${encodeURIComponent(opts.secret).replaceAll('*', '%2A')}` : '/',
  );

  // In-memory cache of disk-scanned session metadata. Stored as the
  // in-flight promise (not the resolved array) so concurrent readers
  // share a single scan. Invalidation nulls the slot; any in-flight
  // resolution is no longer reachable from the cache, so the next read
  // starts a fresh scan against post-mutation disk state.
  let listCache: Promise<SessionInfo[]> | null = null;
  const invalidateListCache = () => {
    listCache = null;
  };

  root.get('/healthz', (c) => c.text('ok'));

  app.get('/v1/instance', (c) => c.json(registry.getInstanceInfo()));

  // --- Sessions ----------------------------------------------------------
  app.post('/v1/sessions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = createSessionSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    const requestedSessionId = parseResult.data.requestedSessionId;
    if (requestedSessionId) {
      if (!isValidSessionId(requestedSessionId)) {
        return c.json({ error: 'invalid requested session ID' }, 400);
      }
      if (registry.get(requestedSessionId)) {
        return c.json({ error: 'session ID already exists', code: 'SESSION_ID_EXISTS' }, 409);
      }
      try {
        await readSessionMetadata(requestedSessionId, home);
        return c.json({ error: 'session ID already exists', code: 'SESSION_ID_EXISTS' }, 409);
      } catch {
        // The requested ID is available.
      }
    }
    const { sessionId } = await registry.create({
      cwd: parseResult.data.cwd,
      model: parseResult.data.model,
      sandboxMode: parseResult.data.sandboxMode ?? 'off',
      name: parseResult.data.name,
      requestedSessionId,
      additionalReadPaths: parseResult.data.additionalReadPaths,
      additionalWritePaths: parseResult.data.additionalWritePaths,
    });
    invalidateListCache();
    return c.json({ sessionId }, 201);
  });

  app.get('/v1/sessions', async (c) => {
    if (listCache === null) listCache = listSessionsOnDisk(home);
    return c.json(await listCache);
  });

  app.get('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'not found' }, 404);
    const entry = registry.get(id);
    if (!entry) return c.json({ error: 'not found' }, 404);

    const sessionsHome = home ?? homedir();
    const logPath = join(sessionsHome, '.chimera', 'sessions', `${id}.compactions.jsonl`);
    let compactionCount = entry.compactionCount;
    let lastCompactedAt = entry.lastCompactedAt;
    try {
      const raw = await readFile(logPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > 0) {
        compactionCount = lines.length;
        let maxTs = 0;
        for (const line of lines) {
          const parsed = JSON.parse(line) as { ts?: number };
          if (typeof parsed.ts === 'number' && parsed.ts > maxTs) {
            maxTs = parsed.ts;
          }
        }
        lastCompactedAt = maxTs;
      }
    } catch {
      // File doesn't exist; fall back to in-memory values.
    }

    return c.json({
      ...entry.agent.session,
      pendingPermissions: entry.agent.pendingPermissionRequests(),
      pendingQuestions: entry.agent.pendingQuestionRequests(),
      compactionActive: entry.compactionActive,
      compactionCount,
      lastCompactedAt,
    });
  });

  app.delete('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'not found' }, 404);
    try {
      // Refuse if the persisted record has children. The in-memory registry
      // doesn't track child links, so we always check disk metadata first.
      let onDisk: Awaited<ReturnType<typeof readSessionMetadata>> | undefined;
      try {
        onDisk = await readSessionMetadata(id, home);
      } catch {
        onDisk = undefined;
      }
      if (onDisk && onDisk.children.length > 0) {
        return c.json(
          {
            error: 'session has children; delete children first',
            children: onDisk.children,
          },
          409,
        );
      }
      const inRegistry = registry.get(id) !== null;
      await registry.delete(id);
      if (onDisk) {
        await coreDeleteSession(id, home);
      }
      invalidateListCache();
      if (!onDisk && !inRegistry) {
        return c.json({ error: 'not found' }, 404);
      }
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/v1/sessions/:id/resume', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'not found' }, 404);
    const existing = registry.get(id);
    if (existing) {
      return c.json({ sessionId: id });
    }
    let meta: Awaited<ReturnType<typeof readSessionMetadata>>;
    try {
      meta = await readSessionMetadata(id, home);
    } catch {
      return c.json({ error: `session ${id} not found on disk` }, 404);
    }
    const { sessionId } = await registry.create({
      cwd: meta.cwd,
      model: meta.model,
      sandboxMode: meta.sandboxMode,
      sessionId: id,
    });
    return c.json({ sessionId });
  });

  app.post('/v1/sessions/:id/fork', async (c) => {
    const parentId = c.req.param('id');
    if (!isValidSessionId(parentId)) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = forkSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    const purpose = parseResult.data.purpose;
    let meta: Awaited<ReturnType<typeof readSessionMetadata>>;
    try {
      meta = await readSessionMetadata(parentId, home);
    } catch {
      return c.json({ error: `parent session ${parentId} not found` }, 404);
    }
    const { childId } = await coreForkSession({
      parentId,
      purpose,
      home,
      rewindIndex: parseResult.data.rewindIndex,
    });
    if (onFork) {
      try {
        // Satisfy the SessionInfo contract expected by onFork.
        const parentInfo: SessionInfo = {
          ...meta,
          lastActivityAt: meta.createdAt,
        };
        await onFork(parentInfo, childId);
      } catch (err) {
        return c.json(
          {
            error: 'fork side-effect failed',
            detail: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
    }
    const { sessionId } = await registry.create({
      cwd: meta.cwd,
      model: meta.model,
      sandboxMode: meta.sandboxMode,
      sessionId: childId,
    });
    invalidateListCache();
    return c.json({ sessionId, parentId }, 201);
  });

  app.get('/v1/sessions/:id/checkpoints', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'not found' }, 404);
    try {
      await readSessionMetadata(id, home);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    const checkpoints = await readCheckpoints(id, home);
    return c.json(checkpoints);
  });

  app.post('/v1/sessions/:id/rewind', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = rewindSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    let meta: Awaited<ReturnType<typeof readSessionMetadata>>;
    try {
      meta = await readSessionMetadata(id, home);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    const entry = registry.get(id);
    const acquired = registry.tryAcquireRewind(id);
    if (acquired === 'busy') return c.json({ error: 'run already in progress' }, 409);
    try {
      // Restore the working tree before truncating the event log: the
      // checkpoint list (and the byte offsets it carries) must be read from
      // the untruncated log, and a failed restore must not lose history.
      let workspaceRestored = false;
      const checkpoints = await readCheckpoints(id, home);
      const target = checkpoints.find((candidate) => candidate.index === parseResult.data.index);
      if (target) {
        const workspace = new WorkspaceCheckpoints({ sessionId: id, cwd: meta.cwd, home });
        workspaceRestored = await workspace.restore(target, checkpoints);
      }
      const truncated = await truncateEventsAtIndex(id, parseResult.data.index, home);
      if (acquired !== null && entry) {
        entry.agent.session.messages = truncated.messages;
        entry.agent.session.toolCalls = truncated.toolCalls;
        entry.agent.session.usage = truncated.usage;
        await writeSessionMetadata(entry.agent.session, home);
      }
      return c.json({ sessionId: id, workspaceRestored });
    } finally {
      if (acquired !== null && typeof acquired === 'object') {
        acquired.release();
      }
    }
  });

  // What a session is doing, small enough for another instance to poll.
  app.get('/v1/sessions/:id/status', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    const { status, mode, cwd, name } = entry.agent.session;
    return c.json({ status, mode, cwd, ...(name ? { name } : {}) });
  });

  app.get('/v1/sessions/:id/context', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.agent.contextBreakdown());
  });

  app.get('/v1/sessions/:id/commands', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.commands);
  });

  app.get('/v1/sessions/:id/skills', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.skills);
  });

  app.get('/v1/sessions/:id/modes', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.modes);
  });

  app.get('/v1/sessions/:id/models', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(await registry.listModels());
  });

  app.get('/v1/sessions/:id/subagents', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(Array.from(entry.subagents.values()));
  });

  app.get('/v1/sessions/:id/paths', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json({
      read: entry.agent.session.additionalReadPaths,
      write: entry.agent.session.additionalWritePaths,
    });
  });

  app.post('/v1/sessions/:id/paths', async (c) => {
    const id = c.req.param('id');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = pathsAddSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    try {
      await registry.addSessionPath(id, parseResult.data.kind, parseResult.data.path);
      return c.body(null, 204);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('no such file or directory')) {
        return c.json({ error: message }, 400);
      }
      if (message === 'not found') {
        return c.json({ error: 'not found' }, 404);
      }
      if (message === 'factory does not support runtime path mutation') {
        return c.json({ error: message }, 501);
      }
      return c.json({ error: message }, 500);
    }
  });

  // --- Messages / interrupt ---------------------------------------------
  app.post('/v1/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const append = c.req.query('append') === 'true';
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = messageSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    const images = parseResult.data.images ?? [];
    if (append) {
      const state = await registry.injectMessage(id, parseResult.data.content, images);
      if (state === 'missing') return c.json({ error: 'not found' }, 404);
      if (state === 'already-running') {
        return c.json({ error: 'run already in progress' }, 409);
      }
      return c.body(null, 204);
    }
    const state = await registry.run(id, parseResult.data.content, images);
    if (state === 'missing') return c.json({ error: 'not found' }, 404);
    if (state === 'already-running') {
      return c.json({ error: 'run already in progress' }, 409);
    }
    return c.body(null, 202);
  });

  app.post('/v1/sessions/:id/interrupt', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.body(null, 204);
    entry.agent.interrupt();
    return c.body(null, 204);
  });

  app.post('/v1/sessions/:id/compact', (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'not found' }, 404);
    const state = registry.compact(id);
    if (state === 'missing') return c.json({ error: 'not found' }, 404);
    if (state === 'already-running') {
      return c.json({ error: 'run already in progress' }, 409);
    }
    return c.body(null, 202);
  });

  // --- Reload (AGENTS.md/CLAUDE.md, etc.) ----------------------------------
  app.post('/v1/sessions/:id/reload', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = reloadSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    if (parseResult.data.systemPrompt !== undefined) {
      entry.agent.setSystemPrompt(parseResult.data.systemPrompt);
    }
    return c.json({ ok: true });
  });

  // --- Modes ---------------------------------------------------------------
  app.post('/v1/sessions/:id/mode', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = modeSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    const previousModel = `${entry.agent.session.model.providerId}/${entry.agent.session.model.modelId}`;
    const result = entry.agent.queueModeSwitch(parseResult.data.mode);
    if (result.status === 'invalid') {
      return c.json({ error: result.error }, 400);
    }
    if (result.status === 'applied') {
      // Idle agent — switch landed immediately. Publish the event on the
      // session bus so SSE subscribers (and the TUI) reflect the change
      // without waiting for the next run.
      entry.bus.publish({
        type: 'mode_changed',
        from: result.from,
        to: result.to,
        reason: 'user',
        effectiveModel: result.effectiveModel,
        effectiveModelChanged: result.effectiveModelChanged,
      });
      if (result.effectiveModelChanged) {
        entry.bus.publish({
          type: 'model_changed',
          from: previousModel,
          to: result.effectiveModel,
        });
        if (entry.agent.modelSettingsState)
          entry.bus.publish({
            type: 'model_settings_changed',
            settingsState: entry.agent.modelSettingsState,
          });
      }
    }
    return c.body(null, 204);
  });

  // --- Goal ---------------------------------------------------------------
  app.put('/v1/sessions/:id/goal', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = goalSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    // The session can be idle, so the event goes on the bus and not into a run.
    entry.bus.publish(entry.agent.setGoal(parseResult.data.condition));
    return c.json({ goal: entry.agent.session.goal ?? null });
  });

  app.get('/v1/sessions/:id/mode', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json({ mode: entry.agent.session.mode, pending: entry.agent.pendingMode });
  });

  // --- Model --------------------------------------------------------------
  app.get('/v1/sessions/:id/model', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.agent.modelSettingsState ?? null);
  });
  app.post('/v1/sessions/:id/model', async (c) => {
    const id = c.req.param('id');
    if (!isValidSessionId(id)) return c.json({ error: 'not found' }, 404);
    const entry = registry.get(id);
    if (!entry) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = modelSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    let result: Awaited<ReturnType<typeof entry.agent.updateModelSettings>>;
    try {
      result = await entry.agent.updateModelSettings(
        parseResult.data as Parameters<typeof entry.agent.updateModelSettings>[0],
      );
    } catch (error) {
      return c.json({ error: `Could not save model settings: ${(error as Error).message}` }, 500);
    }
    if (result.status === 'invalid') {
      return c.json({ error: result.error }, 400);
    }
    if (result.status === 'running') {
      return c.json({ error: 'agent is running; model change not allowed mid-run' }, 409);
    }
    entry.bus.publish({ type: 'model_changed', from: result.from, to: result.to });
    if (result.settingsState)
      entry.bus.publish({ type: 'model_settings_changed', settingsState: result.settingsState });
    return c.json({ from: result.from, to: result.to, settingsState: result.settingsState });
  });

  // --- Permissions -------------------------------------------------------
  // NOTE: /permissions/rules must be registered BEFORE /permissions/:requestId
  // so Hono matches the specific static segment instead of the parametric one.
  app.post('/v1/sessions/:id/permissions/rules', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    if (!entry.gate) return c.json({ error: 'no permission gate configured' }, 501);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = permissionRuleSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    entry.gate.addRule(parseResult.data.rule, parseResult.data.scope);
    return c.json({ ok: true }, 201);
  });

  app.get('/v1/sessions/:id/permissions/rules', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    if (!entry.gate) return c.json([]);
    return c.json(entry.gate.listRules());
  });

  app.delete('/v1/sessions/:id/permissions/rules/:idx', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    if (!entry.gate) return c.json({ error: 'no permission gate configured' }, 501);
    const idx = Number(c.req.param('idx'));
    if (!Number.isInteger(idx)) return c.json({ error: 'bad index' }, 400);
    const rules = entry.gate.listRules();
    if (idx < 0 || idx >= rules.length) return c.json({ error: 'out of range' }, 404);
    entry.gate.removeRule(idx);
    return c.body(null, 204);
  });

  // Answer, or decline to answer, the questions of one `ask_question` call.
  app.post('/v1/sessions/:id/questions/:requestId', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = questionResolutionSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    const requestId = c.req.param('requestId');
    if (!entry.agent.hasPendingQuestion(requestId)) {
      return c.json({ error: 'already resolved' }, 409);
    }
    entry.agent.resolveQuestion(requestId, parseResult.data);
    return c.body(null, 204);
  });

  app.post('/v1/sessions/:id/permissions/:requestId', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    const parseResult = permissionResolveSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ error: 'bad request', errors: parseResult.error.issues }, 400);
    }
    const requestId = c.req.param('requestId');
    if (
      entry.resolvedPermissionIds.has(requestId) ||
      !entry.agent.hasPendingPermission(requestId)
    ) {
      return c.json({ error: 'already resolved' }, 409);
    }
    try {
      const action = parseResult.data;
      if (action.decision === 'allow_with_grant') {
        const proposal =
          entry.agent.pendingPermissionRequest(requestId)?.policyAnalysis?.grantProposal;
        if (
          !proposal ||
          proposal.id !== action.grant.id ||
          proposal.kind !== action.grant.kind ||
          proposal.path !== action.grant.path
        ) {
          return c.json({ error: 'grant does not match pending request' }, 400);
        }
        await registry.addSessionPath(entry.agent.session.id, action.grant.kind, action.grant.path);
        await entry.agent.resolvePermission(requestId, 'allow', undefined, undefined, action.grant);
      } else {
        await entry.agent.resolvePermission(
          requestId,
          action.decision,
          action.decision === 'allow' ? action.remember : undefined,
          action.decision === 'deny' ? action.feedback : undefined,
        );
      }
      entry.resolvedPermissionIds.add(requestId);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof Error && err.message === `No pending permission request: ${requestId}`) {
        return c.json({ error: 'already resolved' }, 409);
      }
      throw err;
    }
  });

  // --- Events (SSE) ------------------------------------------------------
  app.get('/v1/sessions/:id/events', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    const since = c.req.query('since');

    return streamSSE(c, async (stream) => {
      // Subscribe BEFORE replaying buffered events.  If we replayed first
      // then subscribed, any event published in the window between those
      // two calls would be lost.  By subscribing first, we capture live
      // events into a buffer, then replay the ring (which overlaps with
      // the buffer for events already in the ring), then drain the buffer
      // for any events that arrived after the ring snapshot but before
      // the subscribe call returned.  Duplicates are eliminated by
      // tracking the last replayed event ID.
      const liveBuffer: AgentEventEnvelope[] = [];
      let buffering = true;

      const unsubscribe = entry.bus.subscribe((env) => {
        if (buffering) {
          liveBuffer.push(env);
          return;
        }
        // Best-effort; the stream may be closing.
        void stream.writeSSE({
          event: 'agent_event',
          id: env.eventId,
          data: JSON.stringify(env),
        });
      });

      // Replay buffered events from the ring.
      let lastReplayedId: string | undefined;
      for (const env of entry.bus.replay(since)) {
        await stream.writeSSE({
          event: 'agent_event',
          id: env.eventId,
          data: JSON.stringify(env),
        });
        lastReplayedId = env.eventId;
      }

      // Drain the live buffer, skipping events already replayed from the
      // ring (matched by event ID).
      const seenIds = new Set(lastReplayedId ? [lastReplayedId] : []);
      for (const env of liveBuffer) {
        if (seenIds.has(env.eventId)) continue;
        seenIds.add(env.eventId);
        await stream.writeSSE({
          event: 'agent_event',
          id: env.eventId,
          data: JSON.stringify(env),
        });
      }

      // Switch to direct streaming mode.
      buffering = false;

      // SSE comment heartbeat — keeps idle connections from being killed by
      // undici's keep-alive timeout or any intermediate proxy. Comments
      // (lines beginning with `:`) are ignored by EventSource-compatible
      // parsers, including our parseSSE.
      const heartbeat = setInterval(() => {
        void stream.write(': ping\n\n');
      }, 15_000);

      // Keep open until aborted.
      const abort = new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve());
      });
      await abort;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return root.route('/', app);
}

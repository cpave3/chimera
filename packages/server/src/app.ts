import {
  deleteSession as coreDeleteSession,
  forkSession as coreForkSession,
  listSessionsOnDisk,
  type RememberScope,
  type SessionId,
  type SessionInfo,
} from '@chimera/core';
import { streamSSE } from 'hono/streaming';
import { Hono } from 'hono';
import type { AgentRegistry } from './agent-registry';

export interface AppOptions {
  registry: AgentRegistry;
  /** Home directory for session persistence; defaults to os.homedir(). */
  home?: string;
  /**
   * Hook fired when a session is forked. Lets the caller (e.g. the CLI)
   * perform side effects beyond core's metadata copy — notably, copying the
   * parent's overlay upperdir for `overlay`-mode sandboxes.
   */
  onFork?: (parentInfo: SessionInfo, childId: SessionId) => Promise<void> | void;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isValidUlid(id: string): boolean {
  return ULID_RE.test(id);
}

export function buildApp(opts: AppOptions): Hono {
  const { registry, home, onFork } = opts;
  const app = new Hono();

  // In-memory cache of disk-scanned session metadata. Stored as the
  // in-flight promise (not the resolved array) so concurrent readers
  // share a single scan. Invalidation nulls the slot; any in-flight
  // resolution is no longer reachable from the cache, so the next read
  // starts a fresh scan against post-mutation disk state.
  let listCache: Promise<SessionInfo[]> | null = null;
  const invalidateListCache = () => {
    listCache = null;
  };

  app.get('/healthz', (c) => c.text('ok'));

  app.get('/v1/instance', (c) => c.json(registry.getInstanceInfo()));

  // --- Sessions ----------------------------------------------------------
  app.post('/v1/sessions', async (c) => {
    const body = await c.req.json();
    const { sessionId } = await registry.create({
      cwd: body.cwd,
      model: body.model,
      sandboxMode: body.sandboxMode ?? 'off',
      sessionId: body.sessionId,
    });
    invalidateListCache();
    return c.json({ sessionId }, 201);
  });

  app.get('/v1/sessions', async (c) => {
    if (listCache === null) listCache = listSessionsOnDisk(home);
    return c.json(await listCache);
  });

  app.get('/v1/sessions/:id', (c) => {
    const id = c.req.param('id');
    if (!isValidUlid(id)) return c.json({ error: 'not found' }, 404);
    const entry = registry.get(id);
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(entry.agent.session);
  });

  app.delete('/v1/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidUlid(id)) return c.json({ error: 'not found' }, 404);
    try {
      // Refuse if the persisted record has children. The in-memory registry
      // doesn't track child links, so we always check disk metadata first.
      const onDisk = await listSessionsOnDisk(home);
      const target = onDisk.find((s) => s.id === id);
      if (target && target.children.length > 0) {
        return c.json(
          {
            error: 'session has children; delete children first',
            children: target.children,
          },
          409,
        );
      }
      const inRegistry = registry.get(id) !== null;
      await registry.delete(id);
      if (target) {
        await coreDeleteSession(id, home);
      }
      invalidateListCache();
      if (!target && !inRegistry) {
        return c.json({ error: 'not found' }, 404);
      }
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/v1/sessions/:id/resume', async (c) => {
    const id = c.req.param('id');
    if (!isValidUlid(id)) return c.json({ error: 'not found' }, 404);
    const existing = registry.get(id);
    if (existing) {
      return c.json({ sessionId: id });
    }
    const sessions = await listSessionsOnDisk(home);
    const onDisk = sessions.find((s) => s.id === id);
    if (!onDisk) {
      return c.json({ error: `session ${id} not found on disk` }, 404);
    }
    const { sessionId } = await registry.create({
      cwd: onDisk.cwd,
      model: onDisk.model,
      sandboxMode: onDisk.sandboxMode,
      sessionId: id,
    });
    return c.json({ sessionId });
  });

  app.post('/v1/sessions/:id/fork', async (c) => {
    const parentId = c.req.param('id');
    if (!isValidUlid(parentId)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { purpose?: unknown };
    const purpose = typeof body.purpose === 'string' ? body.purpose : undefined;
    const sessions = await listSessionsOnDisk(home);
    const parent = sessions.find((s) => s.id === parentId);
    if (!parent) {
      return c.json({ error: `parent session ${parentId} not found` }, 404);
    }
    const { childId } = await coreForkSession({ parentId, purpose, home });
    if (onFork) {
      try {
        await onFork(parent, childId);
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
      cwd: parent.cwd,
      model: parent.model,
      sandboxMode: parent.sandboxMode,
      sessionId: childId,
    });
    invalidateListCache();
    return c.json({ sessionId, parentId }, 201);
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

  app.get('/v1/sessions/:id/subagents', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    return c.json(Array.from(entry.subagents.values()));
  });

  // --- Messages / interrupt ---------------------------------------------
  app.post('/v1/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const state = await registry.run(id, String(body.content ?? ''));
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

  // --- Reload (AGENTS.md/CLAUDE.md, etc.) ----------------------------------
  app.post('/v1/sessions/:id/reload', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json();
    const systemPrompt = body.systemPrompt;
    if (typeof systemPrompt === 'string') {
      entry.agent.setSystemPrompt(systemPrompt);
    }
    return c.json({ ok: true });
  });

  // --- Permissions -------------------------------------------------------
  // NOTE: /permissions/rules must be registered BEFORE /permissions/:requestId
  // so Hono matches the specific static segment instead of the parametric one.
  app.post('/v1/sessions/:id/permissions/rules', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    if (!entry.gate) return c.json({ error: 'no permission gate configured' }, 501);
    const body = await c.req.json();
    entry.gate.addRule(body.rule, body.scope);
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

  app.post('/v1/sessions/:id/permissions/:requestId', async (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    const requestId = c.req.param('requestId');
    if (
      entry.resolvedPermissionIds.has(requestId) ||
      !entry.agent.hasPendingPermission(requestId)
    ) {
      return c.json({ error: 'already resolved' }, 409);
    }
    const body = await c.req.json();
    const decision: 'allow' | 'deny' = body.decision;
    const remember = body.remember as RememberScope | undefined;
    try {
      entry.agent.resolvePermission(requestId, decision, remember);
      entry.resolvedPermissionIds.add(requestId);
      return c.body(null, 204);
    } catch {
      return c.json({ error: 'already resolved' }, 409);
    }
  });

  // --- Events (SSE) ------------------------------------------------------
  app.get('/v1/sessions/:id/events', (c) => {
    const entry = registry.get(c.req.param('id'));
    if (!entry) return c.json({ error: 'not found' }, 404);
    const since = c.req.query('since');

    return streamSSE(c, async (stream) => {
      // Replay buffered events first.
      for (const env of entry.bus.replay(since)) {
        await stream.writeSSE({
          event: 'agent_event',
          id: env.eventId,
          data: JSON.stringify(env),
        });
      }

      const unsubscribe = entry.bus.subscribe((env) => {
        // Best-effort; the stream may be closing.
        void stream.writeSSE({
          event: 'agent_event',
          id: env.eventId,
          data: JSON.stringify(env),
        });
      });

      // Keep open until aborted.
      const abort = new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve());
      });
      await abort;
      unsubscribe();
    });
  });

  return app;
}

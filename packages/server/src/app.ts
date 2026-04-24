import type { RememberScope } from '@chimera/core';
import { streamSSE } from 'hono/streaming';
import { Hono } from 'hono';
import type { AgentRegistry } from './agent-registry';

export interface AppOptions {
  registry: AgentRegistry;
}

export function buildApp(opts: AppOptions): Hono {
  const { registry } = opts;
  const app = new Hono();

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
    return c.json({ sessionId }, 201);
  });

  app.get('/v1/sessions', (c) => c.json(registry.list()));

  app.get('/v1/sessions/:id', (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    return c.json(e.agent.session);
  });

  app.delete('/v1/sessions/:id', async (c) => {
    const ok = await registry.delete(c.req.param('id'));
    return ok ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });

  app.get('/v1/sessions/:id/commands', (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    return c.json(e.commands);
  });

  app.get('/v1/sessions/:id/skills', (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    return c.json(e.skills);
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
    const e = registry.get(c.req.param('id'));
    if (!e) return c.body(null, 204);
    e.agent.interrupt();
    return c.body(null, 204);
  });

  // --- Permissions -------------------------------------------------------
  // NOTE: /permissions/rules must be registered BEFORE /permissions/:requestId
  // so Hono matches the specific static segment instead of the parametric one.
  app.post('/v1/sessions/:id/permissions/rules', async (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    if (!e.gate) return c.json({ error: 'no permission gate configured' }, 501);
    const body = await c.req.json();
    e.gate.addRule(body.rule, body.scope);
    return c.json({ ok: true }, 201);
  });

  app.get('/v1/sessions/:id/permissions/rules', (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    if (!e.gate) return c.json([]);
    return c.json(e.gate.listRules());
  });

  app.delete('/v1/sessions/:id/permissions/rules/:idx', (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    if (!e.gate) return c.json({ error: 'no permission gate configured' }, 501);
    const idx = Number(c.req.param('idx'));
    if (!Number.isInteger(idx)) return c.json({ error: 'bad index' }, 400);
    const rules = e.gate.listRules();
    if (idx < 0 || idx >= rules.length) return c.json({ error: 'out of range' }, 404);
    e.gate.removeRule(idx);
    return c.body(null, 204);
  });

  app.post('/v1/sessions/:id/permissions/:requestId', async (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    const requestId = c.req.param('requestId');
    if (e.resolvedPermissionIds.has(requestId) || !e.agent.hasPendingPermission(requestId)) {
      return c.json({ error: 'already resolved' }, 409);
    }
    const body = await c.req.json();
    const decision: 'allow' | 'deny' = body.decision;
    const remember = body.remember as RememberScope | undefined;
    try {
      e.agent.resolvePermission(requestId, decision, remember);
      e.resolvedPermissionIds.add(requestId);
      return c.body(null, 204);
    } catch {
      return c.json({ error: 'already resolved' }, 409);
    }
  });

  // --- Events (SSE) ------------------------------------------------------
  app.get('/v1/sessions/:id/events', (c) => {
    const e = registry.get(c.req.param('id'));
    if (!e) return c.json({ error: 'not found' }, 404);
    const since = c.req.query('since');

    return streamSSE(c, async (stream) => {
      // Replay buffered events first.
      for (const env of e.bus.replay(since)) {
        await stream.writeSSE({
          event: 'agent_event',
          id: env.eventId,
          data: JSON.stringify(env),
        });
      }

      const unsubscribe = e.bus.subscribe((env) => {
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

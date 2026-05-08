# Zod Request-Body Validation — Backend Boundary Review Follow-up

**Date:** 2026-05-08
**Scope:** `packages/server/src/app.ts`, `packages/server/test/app.test.ts`, `packages/server/package.json`
**Triggered by:** `reviews/backend-boundary-review.md` sections 1.1, 1.3, 2.4, 3

---

## Files modified and rationale

| File | Change |
|------|--------|
| `packages/server/src/app.ts` | Added Zod schemas for every endpoint that calls `await c.req.json()`. Each schema is checked with `safeParse`; malformed JSON or validation failures return 400 with `error.issues` in the body. Removed the `.catch(() => ({}))` swallow in the fork endpoint. Narrowed the catch in the permission resolve endpoint to ONLY catch the exact `No pending permission request: ${requestId}` error — all other errors now propagate as 500. Fixed the mode endpoint to return 400 (not 404) for invalid mode names. |
| `packages/server/test/app.test.ts` | Added `describe('negative input validation')` with 21 new tests covering: malformed JSON bodies, missing required fields, wrong types (e.g. numeric `sandboxMode`), invalid enum values (e.g. `patternKind: 'invalid-kind'`), invalid permission `decision`, invalid `remember` shapes, 500-vs-409 error-path distinction in permission resolve. |
| `packages/server/package.json` | Added `"zod": "^4.3.6"` to `dependencies` (already a transitive dep via `@chimera/core`, now explicit). |

---

## Summary of behavioral changes

1. **Validation on all JSON bodies** — Every POST endpoint that previously did `await c.req.json()` now validates shape before use. This prevents silent coercion bugs (e.g. `String(body.content ?? '')` producing `'undefined'`) and rejects clearly invalid payloads early.
2. **No more `.catch(() => ({}))`** in `POST /v1/sessions/:id/fork` — malformed JSON now correctly returns 400 instead of being silently treated as an empty object.
3. **Permission resolve error narrowing** — The catch at `app.ts:~400` now only transforms the specific "already resolved" error into HTTP 409. All other exceptions (e.g. internal agent state corruption) propagate uncaught, which Hono renders as 500.
4. **Mode endpoint semantics fixed** — Invalid mode names return 400 (bad request) instead of 404 (not found). 404 is now reserved exclusively for the "session not found" case.
5. **Malformed JSON on all bodies** returns 400 with `error: 'invalid JSON'` instead of crashing or yielding cryptic coercion results.

---

## Caveats / follow-ups

- The permission resolve catch still matches on the **error message string** (`No pending permission request: ${requestId}`). A future refactor in `@chimera/core` could export a custom error class (e.g. `PermissionNotPendingError`) so the server can match on `instanceof` instead of string equality.
- Some empty-catch blocks remain in `packages/server/src/agent-registry.ts` and `packages/server/src/event-bus.ts`; those are assigned to a different worker.
- The `DELETE /v1/sessions/:id` endpoint still exposes raw error messages in 500 responses (review section 2.9). Not in scope for this change.
---

# Type-Safety Fix: Remove `as any` Casts in Permission Resolution

## Files Modified

- `packages/tui/src/App.tsx` — removed `remember as any` at `L1265`; imported
  `RememberScope` from `@chimera/core` and passed `remember` directly to
  `resolvePermission`.
- `packages/tui/src/PermissionModal.tsx` — replaced two `as any` casts (L59,
  L68) with explicit discriminated-union narrowing. The `scope` branch now
  cleanly splits `input === 's'` (emits `{ scope: 'session' }`) vs `input ===
  'p'` (emits `{ scope: 'project', pattern, patternKind }`).
- `packages/tui/test/app.test.tsx` — added 7 new tests covering the full
  PermissionModal state machine and two App-level slash-command flows.
- `packages/client/src/client.ts` — no change required. `resolvePermission`
  was already typed as `remember?: RememberScope`, which is the exact
  discriminated union consumed by the TUI.

## Rationale

Both the `PermissionModal` `onResolve` prop and `ChimeraClient.resolvePermission`
already use the `RememberScope` discriminated union:

```ts
type RememberScope =
  | { scope: 'session' }
  | { scope: 'project'; pattern: string; patternKind: 'exact' | 'glob' }
```

The `as any` casts were suppressing the compiler precisely where the types
were correct. By removing them:

1. `PermissionModal` now emits exact-union payloads at every `props.onResolve`
   callsite.
2. `App.tsx` no longer casts the value before handing it to the client.
3. The type flows directly from modal → App → `resolvePermission`
   → server handler with no loss of type information.

## Behavioral Changes

No runtime behavior changes. All existing `PermissionModal` state-machine
paths (`choose` → `pattern` → `scope`) emit the same server-visible JSON
payloads as before. The change is purely type-safety.

### Test Coverage Added

| Test | What it exercises |
|------|-------------------|
| `PermissionModal` full-flow: allow + session | `A` → `s` emits `{ scope: 'session' }` |
| `PermissionModal` full-flow: allow + project | `A` → `p` emits `{ scope: 'project', …, patternKind: 'exact' }` |
| `PermissionModal` full-flow: pattern → scope | `g` → `Enter` → `p` emits `{ scope: 'project', … }` |
| `PermissionModal` full-flow: deny + session | `D` → `s` emits `{ decision: 'deny', scope: 'session' }` |
| `PermissionModal`: allow once | `a` → pure allow, no remember |
| App: `/new` | Invokes `createSession`, confirms new session rendered |
| App: `/sessions` | Opens interactive picker when sessions exist |

## Caveats / Follow-ups

1. **Pre-existing slash-dispatch failures**: Two tests in
   `slash-dispatch.test.tsx` (`/overlay lists pending changes` and `/discard`) fail
   independently of these changes and are tracked elsewhere.
2. **Commands build**: `@chimera/commands` had a DTS resolution error before
   this task started. A fix was applied by the user or in this session; the
   TUI suite is green after rebuilding.
3. **No `client.ts` signature change needed**: The client was already correctly
  typed; the cast shadow was entirely in the TUI call sites.

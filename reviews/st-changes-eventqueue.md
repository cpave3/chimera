# EventQueue Changes

## Files Modified

- `packages/core/src/event-queue.ts` — fixed race condition in `close()`
- `packages/core/test/event-queue.test.ts` — new test suite (8 tests)

## Rationale

Per `reviews/core-engine-review.md` section 3, `EventQueue` had:
1. No test coverage
2. A race between `push()` and `close()` where a concurrent `push` could `shift()` a resolver from `this.resolvers` while `close()` was mid-iteration, potentially dropping a close signal

## Behavioral Changes

- `close()` now snapshots `this.resolvers` into a local variable and clears the field before iterating.
  - Before: `for (const resolver of this.resolvers) { ... }` followed by `this.resolvers = []`
  - After: `const waiters = this.resolvers; this.resolvers = []; for (const resolver of waiters) { ... }`
  - This closes the ABA window: no concurrent `push` can shift from the list while `close` is iterating.

## Tests Added

1. **Basic FIFO ordering** — buffered values and waiters are consumed in order
2. **Waiters-before-buffer** — pending `next()` calls resolve before new values buffer
3. **Push after close is no-op** — values pushed after `close()` are silently dropped
4. **Close resolves all waiters** — every pending `next()` gets `{ done: true }`
5. **Multiple close calls are idempotent** — repeated `close()` calls are harmless
6. **Drain yields buffered then terminates** — `drain()` async iterator works for pre-buffered values
7. **Drain waits for late pushes** — `drain()` suspends correctly when no values are buffered yet
8. **Stress test** — 10 producers each pushing 50 values, interleaved with a delayed `close()`, confirms no duplicates and graceful termination

## Caveats / Follow-ups

- The fix makes the resolver-list hand-off safe, but `EventQueue` is still not fully thread-atomic (JavaScript is single-threaded, so this only covers async interleaving via `await` boundaries, not true parallelism).
- The `value: undefined as unknown as T` casts for `done: true` results remain in place; fixing the typing gap was out of scope for this task.

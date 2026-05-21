# Technical Debt: TUI Mode Synchronization Race Condition

## Problem Statement
In `packages/tui/src/App.tsx`, the session rehydration effect introduces a race condition where the UI can display a stale mode name after a session transition.

### Root Cause Analysis
The `useEffect` responsible for session rehydration performs an asynchronous `await activeSession.client.getSession(activeSession.sessionId)`. 

If a user-initiated event (like a `mode_changed` event from the server subscription stream) occurs *while* this `await` is in flight, the TUI's `apply()` function will correctly update `activeModeName` to the newest value. However, when the `getSession` promise finally resolves, the subsequent call to `setActiveModeName(s.mode)` uses the snapshot data from the (now stale) `getSession` response, overwriting the correct, newer mode name with the old one.

### Impact
The TUI status bar may momentarily show the correct mode but then flicker back to a previous, incorrect mode name until the user manually triggers a refresh (e.g., via `/mode` or `Shift+Tab`).

### Recommended Fix
To resolve this, we must ensure that the rehydration effect does not overwrite newer state. One approach is to implement a freshness check:
- Track a sequence number or timestamp for `mode_changed` events.
- Only allow `setActiveModeName(s.mode)` from the rehydration effect to execute if the mode in the session snapshot is strictly "newer" than (or equal to) the current UI state's known mode version.

Alternatively, as a simpler mitigation:
- Clear/reset the pending transition state and ensure all session transitions (`/new`, `/attach`, etc.) explicitly reset `activeModeName` to a known default or the server-provided truth before processing new events.

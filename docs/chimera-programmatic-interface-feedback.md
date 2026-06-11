# Chimera programmatic interface feedback

This note captures a hands-on agent evaluation of Chimera's CLI and SDK surfaces.
The exercise was to use Chimera from `/tmp` to create a tiny dependency-free
hello world web app through both:

- `chimera run` via the CLI
- `ChimeraClient` via a `chimera serve --machine-handshake` server

Artifacts from the run were created under `/tmp/chimera-agent-eval/`.

## What worked well

The CLI is a strong programmatic surface for agents. The useful pieces are all
available as flags:

- `--cwd` makes the target workspace explicit.
- `--auto-approve all` lets a parent agent run an unattended evaluation.
- `--max-steps` bounds runaway work.
- `--json` emits NDJSON events instead of requiring terminal scraping.
- `--stdin` is available for prompts that are easier to pipe than quote.

The `--json` stream was especially useful. It exposed task-list updates, tool
starts, tool results, usage updates, assistant deltas, and `run_finished`. That
was enough to observe whether Chimera followed a TDD loop without inspecting
only the final prose.

The SDK has a clean core shape. Once a server is running, this is the essential
agent loop:

```js
import { ChimeraClient } from '@chimera/client';

const client = new ChimeraClient({ baseUrl });

for await (const event of client.send(sessionId, prompt)) {
  if (event.type === 'tool_call_start') {
    console.log(event.name, event.display?.summary);
  }

  if (event.type === 'run_finished') {
    console.log(event.reason);
  }
}
```

This felt like the right abstraction: the SDK does not bypass Chimera's normal
agent behavior, permissions, tool execution, or event stream. The SDK-driven run
produced the same kind of TDD workflow as the CLI-driven run.

The server handshake is automation-friendly:

```bash
chimera serve --cwd /tmp/example --auto-approve all --machine-handshake
```

It emits a single JSON object containing `url`, `sessionId`, and `pid`, which is
easy for a harness to parse.

## Friction points

The main CLI surprise is that even `chimera run` starts a local HTTP/SSE server.
In restricted environments, binding `127.0.0.1` can fail with:

```text
listen EPERM: operation not permitted 127.0.0.1
```

That is understandable given the architecture, but it means "one-shot CLI" is
not purely process-local from a sandbox policy perspective.

Global skill discovery produced warnings before the useful output:

```text
skills: ... skipped - frontmatter "name" missing or does not match directory
```

For human use this is tolerable. For agent harnesses it is noise that has to be
filtered, especially when the caller wants to parse machine-readable output.

The SDK is easy after bootstrap, but bootstrap is still manual:

1. Start `chimera serve --machine-handshake`.
2. Parse the handshake.
3. Construct `ChimeraClient`.
4. Send to the handshake `sessionId`.
5. Stop the server process when finished.

That is straightforward, but every SDK consumer will likely recreate the same
wrapper. A first-class helper that starts a server and returns `{ client,
sessionId, close }` would make the SDK feel much more complete for agents.

The SDK intentionally yields raw events. That is flexible, but an agent harness
needs to write its own event summarizer for common cases:

- tool call progress
- task-list status
- final assistant text
- run exit reason
- permission requests and timeouts

Small helper utilities for these common event reductions would improve
ergonomics without hiding the raw stream.

Using the local SDK from outside the monorepo required importing the built
`dist` file directly during this evaluation:

```js
import { ChimeraClient } from '/var/home/cameron/Projects/chimera/packages/client/dist/index.js';
```

That is fine for local development, but examples and docs should show both the
published-package import and the local-repo fallback.

## Suggestions

Add a small SDK launcher helper for agent harnesses:

```ts
const chimera = await launchChimera({
  cwd,
  autoApprove: 'all',
  maxSteps: 20,
});

try {
  for await (const event of chimera.client.send(chimera.sessionId, prompt)) {
    // consume events
  }
} finally {
  await chimera.close();
}
```

Add an event utility layer on top of the raw SDK:

- `collectFinalText(events)`
- `summarizeToolEvent(event)`
- `isTerminalEvent(event)`
- `runToCompletion(client, sessionId, prompt, handlers)`

Consider suppressing non-fatal discovery warnings from stdout/stderr when
`--json` is enabled, or emitting them as structured warning events. This would
make `chimera run --json` cleaner for automation.

Document that `chimera run` and `chimera serve` both bind localhost, so sandboxed
agent environments need permission to listen on `127.0.0.1`.

Add an "agent harness quickstart" that demonstrates:

- creating a temp workspace
- running `chimera run --json`
- starting `chimera serve --machine-handshake`
- using `ChimeraClient.send()`
- consuming tool/result/run events
- cleaning up the server process

## Bottom line

The underlying programmatic model feels good. The CLI is already usable by an
agent, and the SDK has the right primitive: a typed client over the same
HTTP/SSE protocol that the TUI uses. The biggest opportunity is packaging the
common bootstrap and event-reduction patterns so every downstream agent harness
does not have to rediscover them.

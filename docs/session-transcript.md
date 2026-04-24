# Example session transcript

This is a plain-text transcript of a short `chimera run` invocation against a stub provider. It demonstrates the MVP capabilities: streamed text, a bash tool call with a `[host]` target badge, a step boundary, and a terminal `run_finished`.

The transcript was captured from `@chimera/cli`'s `e2e-run.test.ts` fixture (`bash tool call round-trip`), which exercises the real `Agent` → `streamText` → `LocalExecutor` → `bash` path using a mocked language model.

## Invocation

```
$ chimera run "please echo hello"
```

## NDJSON event stream (`chimera run --json`)

Events below are simplified (eventId / ts / sessionId stripped) to show the logical shape. Each real line is one JSON object.

```json
{"type":"session_started","sessionId":"01JXXXXXXXXXXXXXXXXXXXXXX"}
{"type":"user_message","content":"please echo hello"}
{"type":"tool_call_start","callId":"01JYYYYYYYYYYYYYYYYYYYYYY","name":"bash","args":{"command":"echo hello"},"target":"host"}
{"type":"tool_call_result","callId":"01JYYYYYYYYYYYYYYYYYYYYYY","result":{"stdout":"hello\n","stderr":"","exit_code":0,"timed_out":false},"durationMs":12}
{"type":"step_finished","stepNumber":1,"finishReason":"tool-calls"}
{"type":"assistant_text_delta","delta":"done."}
{"type":"assistant_text_done","text":"done."}
{"type":"step_finished","stepNumber":2,"finishReason":"stop"}
{"type":"run_finished","reason":"stop"}
```

## Rendered (human-readable) form

```
[tool] bash {"command":"echo hello"}
done.
```

## What this demonstrates

- The Agent uses `streamText` + tool dispatch; no custom orchestration.
- `bash` is routed through `LocalExecutor` with a `target: "host"` badge, matching the MVP default when sandbox is off.
- A session snapshot is written to `~/.chimera/sessions/<id>.json` on every `step_finished`.
- The server's SSE ring buffer lets any future `chimera attach` client replay the run.
- Exit code maps: `run_finished.reason: "stop"` → 0.

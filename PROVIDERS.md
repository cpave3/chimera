# Providers

Chimera supports any provider endpoint that is either OpenAI-compatible or Anthropic-compatible. The provider registry is **shape-based, not vendor-locked**: configure the shape, base URL, and API key, then reference models as `<providerId>/<modelId>`.

## Config

Add providers to `~/.chimera/config.json`:

```json
{
  "providers": {
    "anthropic": {
      "shape": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "env:ANTHROPIC_API_KEY"
    },
    "openai": {
      "shape": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "env:OPENAI_API_KEY"
    },
    "openrouter": {
      "shape": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "env:OPENROUTER_API_KEY"
    }
  },
  "defaultModel": "anthropic/claude-opus-4-7"
}
```

`apiKey` may be either `env:VAR_NAME` (resolved at use time) or a plain string (not recommended; a warning is logged).

## Prompt caching

Chimera keeps the head of every request stable — tool definitions, system
prompt, then the conversation in order — so providers can serve it from their
prompt cache.

- **`shape: "anthropic"`**: caching is opt-in per request, so Chimera marks the
  end of the system prompt and the end of the conversation with
  `cache_control` breakpoints. If a proxy rejects those fields, turn them off
  for that provider:

  ```json
  { "providers": { "my-proxy": { "shape": "anthropic", "baseUrl": "…", "apiKey": "…", "promptCaching": false } } }
  ```

- **`shape: "openai"`**: no markers are sent. Endpoints that cache do it
  automatically on a stable prefix.

The TUI usage widget shows the cached share of the last prompt as
`cache N%` when the provider reports cached input tokens. A mode change,
`/reload`, or a `/model` switch changes the prefix and starts the cache again.

## Known-good combos

| Provider | Shape | Notes |
| --- | --- | --- |
| Anthropic API | `anthropic` | Official, supports extended thinking. |
| OpenAI API | `openai` | Tool calling works. |
| OpenRouter | `openai` | Can route to Anthropic, Google, Meta, etc. `cache_control` on Anthropic models via the OpenAI-shape endpoint has historically been inconsistent — use the Anthropic shape if caching matters. |
| vLLM (local) | `openai` | Fine for most models; smaller models occasionally hallucinate tool JSON. |
| Ollama | `openai` | Enable tool calling with a tool-capable model (e.g. `llama3.1`). |
| AWS Bedrock proxy | `anthropic` | Configure via a proxy that speaks Anthropic's wire format. |
| GCP Vertex proxy | `anthropic` | Same. |

## Per-model overrides

The TUI's token-usage indicator computes "remaining budget" against a known
context window. Chimera ships a built-in table covering the current Claude
and OpenAI families. For models we don't know about (or to override the
default), add a `models` block keyed by `<providerId>/<modelId>`:

```json
{
  "models": {
    "openrouter/anthropic/claude-opus-4-7": { "contextWindow": 1000000 },
    "local/some-experimental-2026": { "contextWindow": 256000 },
    "openai/codex": { "toolCallShape": "codex" }
  }
}
```

Resolution order: config override → built-in table → `128000` fallback (with
a one-shot stderr warning so unknown models are visible).

### Model profiles

Each model resolves to a profile that decides what the model is given to
work with. Three fields can be set per model; anything you leave out comes
from the model's family.

| Field | Values | Default |
| --- | --- | --- |
| `toolCallShape` | `chimera`, `codex` | `chimera` |
| `editFormat` | `replace`, `patch` | `patch` for GPT and Codex model ids (`gpt`, `gpt-*`, `o<digit>*`, `codex*`) and for any model with `toolCallShape: "codex"`; `replace` for every other model |
| `promptStyle` | `lean`, `guided` | `lean` for Claude, GPT and Codex model ids and for any model with `toolCallShape: "codex"`; `guided` for every other model |

```json
{
  "models": {
    "local/qwen3-coder": { "promptStyle": "lean" },
    "openrouter/some-vendor/some-model": { "editFormat": "patch" }
  }
}
```

- **`editFormat`** picks the edit tool. `replace` registers `edit`
  (exact-string replacement). `patch` registers `apply_patch` instead, which
  takes the Codex patch envelope and can add, update, delete and move several
  files in one call. A patch applies as a whole or not at all.
- **`promptStyle: "guided"`** appends a short working-method section to the
  system prompt: use the dedicated tools, read before editing, check each
  result, keep a task list, never repeat a failed call unchanged. Models that
  follow such rules unprompted do better with `lean`.
- **`toolCallShape: "codex"`** renames the tools for models that expect
  Codex-style names and arguments: `glob` becomes `find`, `ls` is added, and
  `bash` and `grep` take Codex-style arguments. Every other tool is unchanged,
  so a codex-shape session has the same capabilities as a native one.

The tools section of the system prompt is generated from the tools the
session registers, so it always matches the profile and the active mode.

A `/model` change applies the new model's profile on the next run: the tool
names, the edit tool and the prompt style follow the model. Tool calls
already in the conversation keep their old names.

The profile also carries an output budget (8% of the context window, between
2,000 and 25,000 tokens) for the size of a single tool result.

When Codex is reached through Manticore's OpenAI-compatible proxy, keep the
provider as normal chat-completions and opt the model into the Codex tool
surface:

```json
{
  "providers": {
    "manticore": {
      "shape": "openai",
      "baseUrl": "http://localhost:3000/v1",
      "apiKey": "env:MANTICORE_API_KEY"
    }
  },
  "models": {
    "manticore/codex/gpt-5-codex": { "toolCallShape": "codex" }
  }
}
```

## Errors, retries and the response timeout

A model step can fail for reasons that have nothing to do with the task. The
agent loop handles three of them without ending the run:

- **Temporary provider errors** (HTTP 408, 409, 429, 5xx, overload, a dropped
  connection). The step is sent again after a wait, up to four times. The wait
  follows the provider's `retry-after` header (capped at 60 seconds) and
  otherwise doubles from one second. The TUI prints
  `provider error: … — retry 2/4 in 2s`. A step is only retried when none of
  its tool calls had started, so a retry never repeats a side effect.
- **Context overflow.** When the provider rejects a prompt for its length, the
  agent runs one summarizing compaction and sends the step again.
- **Output cutoff.** When an answer stops at the model's output limit, the
  agent asks the model to continue, at most twice per run. If the answer is
  still cut off, the run ends with the reason `output_limit`.

Set `fallbackModel` in `~/.chimera/config.json` to finish a run on a second
model when the first stays unavailable after its retries:

```json
{ "fallbackModel": "anthropic/claude-haiku-4-5" }
```

The fallback applies to the rest of that run only. The next run starts on the
session model again.

`responseTimeoutMs` (default 120000, `0` disables) is an **idle** timeout: it
measures how long the model produces no output. It restarts on every stream
event and is suspended while a tool call is executing, so a long build, test
run, or subagent never trips it. A model that goes silent for the whole
period ends the run with the reason `timeout`.

## Nested model IDs

`providerId/modelId` splits on the first `/` only, so OpenRouter-style model IDs like `openrouter/anthropic/claude-opus-4` resolve to `provider=openrouter`, `modelId=anthropic/claude-opus-4`.

## Caveats

Some compatible endpoints are only partially compatible:

- Anthropic's `extended_thinking` / `thinking` blocks are Anthropic-only; using them against an OpenAI-shape endpoint silently omits them.
- Tool calling semantics vary by model; Chimera does not attempt to detect or fix this — pick a model that supports tool calling.
- Chimera does not bundle any API keys. Keys resolved from `env:` references are never logged.

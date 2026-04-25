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
    "local/some-experimental-2026": { "contextWindow": 256000 }
  }
}
```

Resolution order: config override → built-in table → `128000` fallback (with
a one-shot stderr warning so unknown models are visible).

## Nested model IDs

`providerId/modelId` splits on the first `/` only, so OpenRouter-style model IDs like `openrouter/anthropic/claude-opus-4` resolve to `provider=openrouter`, `modelId=anthropic/claude-opus-4`.

## Caveats

Some compatible endpoints are only partially compatible:

- Anthropic's `extended_thinking` / `thinking` blocks are Anthropic-only; using them against an OpenAI-shape endpoint silently omits them.
- Tool calling semantics vary by model; Chimera does not attempt to detect or fix this — pick a model that supports tool calling.
- Chimera does not bundle any API keys. Keys resolved from `env:` references are never logged.

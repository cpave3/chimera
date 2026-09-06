# Model generation settings

Generation settings are model-specific. The settings resolver validates values before the AI SDK serializes a request. Unknown models keep their existing legacy defaults, but new selections require a verified profile or an explicit capability declaration.

## Enable Manticore discovery

Merge this option into your existing provider. Keep your current URL, key, and headers:

```json
{
  "providers": {
    "manticore": {
      "shape": "openai",
      "baseUrl": "http://manticore:8080/v1",
      "apiKey": "env:MANTICORE_API_KEY",
      "capabilitySource": "manticore"
    }
  }
}
```

This selects the OpenAI-compatible adapter and enables authenticated `/model-capabilities?model=<alias>` discovery. Discovery uses the provider key, a three-second timeout, and a 30-second cache. Selecting or running a model refreshes its capabilities. If discovery fails, the model remains available with legacy defaults; new controls show unavailable support. Existing explicit overrides must still validate before a run.

Deploy Manticore support first, then Chimera, then Legato. These source changes do not restart services or edit the user's global configuration.

## Configure model defaults

```json
{
  "models": {
    "manticore/sol": {
      "contextWindow": 256000,
      "toolCallShape": "codex",
      "settings": { "reasoningEffort": "max", "parallelToolCalls": false }
    },
    "anthropic/claude-opus-4-6": {
      "settings": { "thinking": "adaptive", "reasoningEffort": "high" }
    },
    "anthropic/claude-sonnet-4-5": {
      "settings": { "thinking": "on", "thinkingBudgetTokens": 2048, "maxOutputTokens": 8192 }
    },
    "manticore/kimi": { "settings": { "thinking": "off" } }
  }
}
```

The last example requires an alias that resolves to a model with non-thinking support, such as Kimi K2.5 or K2.6. Kimi K2.7 Code requires thinking.

`maxOutputTokens` includes thinking tokens. Chimera compensates for the native Anthropic adapter's budget addition. An explicit Anthropic Off sends `thinking.type=disabled`. Unsupported legacy Codex output caps remain readable, but do not appear as effective or enforced limits.

Anthropic parallel-tool Off maps to `tool_choice.disable_parallel_tool_use=true`.

## CLI, SDK, and session API

```sh
chimera run --model manticore/sol --model-settings '{"reasoningEffort":"max","parallelToolCalls":false}' --prompt 'Inspect this project'
```

`serve` and the interactive command also accept `--model-settings`. The client SDK accepts `model.settings` when creating a session and provides `getModelSettings(sessionId)` and `updateModelSettings(sessionId, request)`.

`GET /v1/sessions/:id/model` returns `{model, overrides, defaults, effective, capabilities}`. An older embedder without a settings resolver returns null. `POST` accepts an atomic update:

```json
{
  "expectedModel": "manticore/sol",
  "settings": { "reasoningEffort": "max", "parallelToolCalls": false }
}
```

Omitted properties retain overrides. A null setting removes that override. `resetSettings: true` clears all overrides for the target model before applying the patch. Omit `model` for a settings-only update; `model: null` returns to the mode or session default model. Invalid selections return 400, active runs return 409, and persistence failures do not change live settings. The response and `model_settings_changed` event contain authoritative state.

Overrides are saved by model reference. Resume and fork retain them. Mode changes use the effective model's settings. An implicit child inherits its parent's current effective settings; an explicit child model uses its own defaults. Vision fallback and an explicit compaction model use their own defaults. Active-model compaction uses session settings.

SDK creation defaults, such as temperature and output limits, are saved separately by model reference. Updates do not promote overrides into defaults. Reset, resume, and fork retain the original creation defaults.

## Custom compatible endpoints

Select `adapter: "compatible"` on an OpenAI-shaped provider. Declare the actual server protocol per provider or per model:

```json
{
  "models": {
    "local/my-qwen": {
      "requestProfile": "template",
      "capabilities": {
        "thinking": { "status": "supported", "type": "enum", "values": ["on", "off"] },
        "temperature": { "status": "supported", "type": "number", "min": 0, "max": 2 }
      },
      "settings": { "thinking": "off", "temperature": 0 },
      "providerExtensions": { "repetition_penalty": 1.05 }
    }
  }
}
```

`template` writes `chat_template_kwargs.enable_thinking`. `thinking` writes `thinking.type`. Use only the profile your endpoint implements. A model name alone does not establish a local server's protocol. The native OpenAI adapter remains the default unless a provider explicitly selects compatible transport.

Provider extensions require compatible transport. They cannot overwrite normalized settings, messages, tools, model selection, streaming, or authentication fields. SDK integrations can call the exported `resolveModelSettings(spec, capabilities, defaults, overrides, extensions)` helper.

## Profile limits

| Profile | Supported controls and limits |
| --- | --- |
| Manticore Codex | Exact metadata effort lists, including `max` and model-specific `ultra`; thinking cannot be disabled. Summary suppression is separate. Sampling and output caps are unsupported. |
| Native Anthropic | Adaptive thinking and effort on Opus 4.6/4.7 and Sonnet 4.6; budget-based thinking on known earlier models. Budget must be below the total output limit. No sampling with thinking; use either temperature or top-p. Opus 4.7 does not accept sampling. |
| Native OpenAI Chat | Model-specific effort, verbosity, tier, output, and tool controls. Use compatible transport for effort values such as `max` that the installed native serializer cannot encode. Sampling requires disabled reasoning on reasoning models. |
| Known GLM compatible routes | Thinking, output, and sampling; GLM-5.3 requires thinking. GLM-5.2 exposes canonical `high`/`max`, not aliases the server remaps. GLM-5.3 adds `low`. |
| Known Kimi compatible routes | K2.5/K2.6 offer On/Off; K2.7 Code offers On only. Sampling is fixed by the endpoint. |
| Unknown/local routes | Explicit declarations control new settings. No capability guesses from aliases. |

Capabilities describe the requested protocol, not account entitlements. An upstream can reject a service tier or a changed model contract. Codex choices come from backend model metadata, not public OpenAI model names. Opaque Codex reasoning items survive tool continuations without becoming display text.

Verified references: [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort), [GLM request parameters](https://docs.z.ai/api-reference/llm/chat-completion), [Kimi K2.6](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart), [Kimi K2.7 Code](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart). Keep `contracts/model-settings-v1.json` identical in Chimera, Manticore, and Legato when changing the contract.

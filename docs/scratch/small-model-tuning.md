# Planned: better results with small local models

Status: plan ready, no code changed. Written 2026-10-11 from the first eval
pass. Revised 2026-10-12 after a second, targeted pass that found the cause of
the lost answers.

The goal is to make Chimera do better with small local models and to change
nothing for the large ones. The eval runner is in `packages/evals`; see
[../evals.md](../evals.md).

## The evidence, and its limits

### First pass (2026-10-11)

`qwen/qwen3.5-9b` (q4_k_m) in LM Studio, the `guided` variant (the profile an
unknown model gets today), 14 tasks, **one run of each**, a 32,768 token
context.

| Solved | Finished | Median steps | Failed tool calls | Median time | First-step prompt |
| --- | --- | --- | --- | --- | --- |
| 11 of 14 | 14 of 14 | 4.5 | 5 of 71 | 7.2 s | 5,671 tokens |

The three runs that were not solved:

- `create-file`: one `write` call, no look at `package.json`. It wrote
  `module.exports` in a project with `"type": "module"`.
- `answer-question` and `explain-only`: the run ended with no assistant text.

"11 of 14" hides the size of that last problem. **11 of the 14 runs have no
`assistant_text_done` event.** Only two checks read the answer, so the other
nine runs count as solved while the user would have seen nothing.

### Second pass (2026-10-12)

Raw requests and responses, captured with a logging proxy between Chimera and
LM Studio. The logs, the proxy and the replay script are in
`packages/evals/.results/second-pass-2026-10-12/` (git ignores it).

`answer-question` and `explain-only`, one run each:

| Model | `guided` (native adapter) | `compatible` |
| --- | --- | --- |
| `qwen3.5-9b` | 0 of 2 answered | 2 of 2 |
| `gemma-4-12b` | 2 of 2 | 2 of 2 |
| `qwen3.8-27b` | 2 of 2 | 2 of 2 |

Then the last request of each failed 9B run was sent again, five times for
each of four changes (ten trials for each row):

| Change to the request | Trials with an answer in `content` |
| --- | --- |
| None: the history the native adapter sends | 0 of 10 |
| `reasoning_content` put back on the earlier assistant turns | 8 of 10 (the other two called a tool again) |
| `chat_template_kwargs: { enable_thinking: false }` | 1 of 10; LM Studio ignored it and the model still thought |
| `reasoning_effort: "none"` | 10 of 10, no thinking, about half the output tokens |

Limits: two tasks, one 9B model, one server. The 12B and 27B results are two
runs each. Everything below item 2 is still a guess that the evals must test.

## 1. The answer is lost after tool calls (defect, cause found)

What happens with Qwen 9B on the native OpenAI adapter:

1. The model thinks, then calls a tool. LM Studio returns the thinking in
   `reasoning_content`. The native adapter does not read that field.
2. Chimera sends the assistant turn back as `content: ""` plus `tool_calls`,
   with no thinking.
3. On the last step the model sees earlier turns of its own with no thinking.
   It writes **the whole answer inside the thinking block** and stops:
   `finish_reason: stop`, `content` empty, `completion_tokens` 105 of which
   `reasoning_tokens` 104.
4. The native adapter drops `reasoning_content`, so the run ends with nothing.

The answer is generated and then dropped. The compatible adapter puts
`reasoning_content` back on each assistant turn, and the model then writes its
answer in `content`.

Two more facts from the logs:

- **The compatible adapter gives no usage** because its request has no
  `stream_options: { include_usage: true }`. `createOpenAICompatible` takes
  `includeUsage`; `packages/providers/src/registry.ts` does not set it. Context
  tracking and compaction use `usage_updated`, so this must be fixed before a
  local model depends on that adapter.
- Thinking off (`reasoning_effort: "none"`) also removes the defect, on the
  native adapter, with no other change.

## 2. Compaction budgets do not fit a small window (defect)

With `contextWindow: 32768` Chimera does not start:

```
Compaction invariant violated: reserveTokens (16384) + keepRecentTokens (20000) >= contextWindow (32768).
```

Any window of 36,384 tokens or less fails, and that is a usual size for a
local model.

## The plan

### Step 1: fix the defects

Each of these has a clear reproduction and needs no eval to justify it. One
commit each, test first.

1. **Usage on the compatible adapter.** Pass `includeUsage: true` in
   `registry.ts`. Open: also for `manticore`, or only for
   `adapter: "compatible"`? Only the second changes nothing for the large
   models; check first whether Manticore already reports usage.
2. **Local servers get the compatible adapter.** The native path cannot read
   `reasoning_content` at all, so this is a choice of adapter, not a patch.
   Proposed: a provider with `shape: "openai"`, no `adapter`, and a `baseUrl`
   on loopback or a private address defaults to `compatible`. An explicit
   `adapter` wins. OpenAI, OpenRouter and other public hosts keep the native
   adapter. The other choice is a note in `PROVIDERS.md` only, which leaves
   the default broken.
3. **A guard for an empty last step.** When a step ends with `stop`, no text
   and no tool call, the user gets nothing on any adapter. Ask the model once
   more for its answer as a message, and emit a warning event. A large model
   does not produce such a step, so it sees no change.
4. **Compaction defaults from the window.** In `resolveCompactionConfig`
   (`packages/cli/src/compaction.ts`), `min(16384, window / 8)` and
   `min(20000, window / 4)`. A window above about 131K gets the values of
   today. An explicit `compaction` in config still wins. Then remove the same
   override from `packages/evals/src/home.ts`.
5. **`read`, `edit`, `write` accept the working directory without its slash.**
   Seen in 3 of the 18 runs of Qwen 9B so far, and in none of the 8 runs of
   the other two models. In `local-executor.ts`, a
   relative path that starts with the working directory minus its leading
   slash resolves to the absolute path. This changes an `ENOENT` into a
   success and nothing else.

### Step 2: make the evals show what matters

1. An `answered` column in the report: runs that end with assistant text.
   Without it the worst defect of the first pass was invisible.
2. A `no-thinking` variant: a `thinking` capability on the model entry and
   `settings: { thinking: "off" }`, with **no** `requestProfile: "template"`.
   The default profile turns that into `reasoning_effort: "none"`
   (`model-settings.ts`), which LM Studio obeys. `template` writes
   `chat_template_kwargs.enable_thinking`, which LM Studio ignores. Check the
   wire format once with the logging proxy.
3. A tool set for a variant without a mode, so `core-tools` does not also add
   a mode section to the prompt.
4. Four or five tasks kept out of the tuning loop, and some harder tasks.
5. A provider option in `home.ts` (`PROVIDER_ID` is fixed to LM Studio) for a
   large-model control run.

### Step 3: the baseline

After step 1, with the GPU free:

```
pnpm --filter @chimera/evals evals run --variants guided,compatible,no-thinking,core-tools --trials 3
```

3 models x 4 variants x 14 tasks x 3 trials = 504 runs. An estimate from the
run times of today (medians of 7 s, 8 s and 17 s for the three models): about
two hours.

One cell is 42 runs. A difference under about 15 points between two cells is
noise; run five trials before a close call.

### Step 4: what the baseline decides

- **Thinking on or off for small Qwen.** Both remove the defect. Off is
  cheaper (about half the output tokens for each step). In the replay of one
  first step, thinking on gave the bad path 4 times of 4 and thinking off 0 of
  4. Unknown: whether thinking helps on the harder tasks.
- **A smaller tool set.** First-step prompt for `Reply with the single word
  ok.`, in a clean home:

  | Setup | Tokens |
  | --- | --- |
  | `guided` | 5,688 |
  | `lean` | 5,470 |
  | `patch` | 5,792 |
  | `guided`, no skills, no subagents | 4,897 |
  | A mode with `read`, `edit`, `write`, `glob`, `grep`, `bash` | 3,491 |

  (The same prompt in Cameron's own home was 9,810 tokens: MCP tools, web
  search, user skills and instructions add about 4,000.) If `core-tools`
  helps, add a profile field for the tool set to `ModelProfile`
  (`packages/providers/src/model-profile.ts`), with the full set as the
  default.
- **Edits to the guided prompt.** `GUIDED_METHOD` in
  `packages/core/src/prompts/role.ts` goes only to models with
  `promptStyle: guided`. Candidate rules, each from one run: look at a
  neighbouring file and the project config before you create a file; give the
  answer as a message, not with a shell command. Add a rule only when its
  failure shows in several trials, and check it on the tasks kept out of the
  loop. Also compare `guided` with `lean`: the rules cost about 220 tokens and
  their value is not measured.
- **`patch` against `replace`** for the edit tool, from the same run data.

### Step 5: profiles for the Qwen and Gemma families

`resolveModelProfile` knows only GPT and Claude ids. When step 4 gives
results, add family entries so a local model gets its tuned profile with no
config: prompt style, edit format, tool set, thinking. A model that matches no
family keeps the behaviour of today.

## Keeping the large models as they are

- **By construction.** A test that pins the composed system prompt and the
  tool list for one Claude id and one GPT id. A small-model change that leaks
  then fails at once. `packages/core/test/compose.test.ts` tests the sections
  of the prompt but pins no whole prompt for a model id, so this test is new.
  Add it before step 1.
- **By measurement.** Run the same tasks with a large model as a control
  (step 2, item 5). These 14 tasks are easy for a large model: they show a
  large regression and hide a small one. The harder tasks are for that.

## Open points

- Step 1, items 1 and 2 need a decision from Cameron: usage for Manticore, and
  the automatic adapter for local addresses.
- The models asked for were "Qwen 3.8 9B" and "Gemma 35B". Neither is
  downloaded. The default set is `qwen3.5-9b`, `gemma-4-12b` and
  `qwen3.8-27b`; `gemma-4-26b` and `qwen3.6-35b` are selectable.
- `evals run` with real models now works end to end, with the load and the
  unload (8 runs on 2026-10-12).
- The first pass is in `packages/evals/.results/first-pass-qwen3.5-9b.json`
  and `.results/runs/qwen3.5-9b/guided/` on Cameron's desktop only.

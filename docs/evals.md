# Evals with local models

`packages/evals` measures how well Chimera does small coding tasks with a
model on a local server. Use it to compare model profiles: prompt style, edit
format, tool set and adapter.

It runs on [evalite](https://www.evalite.dev/). Each run of a task starts the
real `chimera run --json` in a new workspace, then a check decides whether the
task was done.

## Before a run

- LM Studio with its server on (`lms server start`) and the models downloaded.
- A built CLI: `pnpm -r build`.
- `bubblewrap` on Linux. The evals keep the commands of the model in the
  [OS sandbox](bash-command-policy.md#os-sandbox) and do not start without it.

## Commands

```
pnpm --filter @chimera/evals evals run            # the default models, the profile of today
pnpm --filter @chimera/evals evals run --models qwen3.5-9b --variants all --trials 5
pnpm --filter @chimera/evals evals run --tasks edit,fix-* --trials 1
pnpm --filter @chimera/evals evals list           # models, variants and tasks
pnpm --filter @chimera/evals evals report         # the report of the last run again
pnpm --filter @chimera/evals evals ui             # every stored run, in the evalite web UI
```

`run --help` lists the flags. The ones you use most:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--models` | `qwen3.5-9b,gemma-4-12b,qwen3.8-27b` | Ids from `list`, or any model key of the server (`lms ls`). |
| `--variants` | `guided` | Profile variants, or `all`. |
| `--tasks` | every task | Task ids, categories, or id prefixes that end in `*`. |
| `--trials` | 3 | Runs of each task. A small model does not give the same result twice. |
| `--context` | 32768 | Context length the model is loaded with, and the window Chimera is told. |
| `--no-load` | off | Use the model the server has loaded. For a server on another machine, with `--base-url`. |
| `--keep-loaded` | off | Do not unload the last model when the run ends. |

A run loads one model at a time with `lms load`. It first unloads every
loaded model, and at the end it unloads its own.

## What a run does

For each model, variant, task and trial:

1. Write the files of the task to a new directory and commit them.
2. Write a `~/.chimera` for this run only: the local provider, the profile of
   the variant, and the OS sandbox set to `required`. Your own config, skills,
   modes, hooks and MCP servers are not used.
3. Start `chimera run --json` there, with a step limit and a time limit. A run
   that asks for a permission is stopped, because nobody can answer.
4. Run the check of the task.

## Variants

| Variant | What it changes |
| --- | --- |
| `guided` | Nothing. This is the profile an unknown model gets today. |
| `lean` | `promptStyle: lean`: no working-method rules in the prompt. |
| `patch` | `editFormat: patch`: `apply_patch` in place of `edit`. |
| `compatible` | `adapter: compatible` on the provider, which reads `reasoning_content`. |
| `core-tools` | A mode with only `read`, `edit`, `write`, `glob`, `grep` and `bash`; no skills, no subagents. |

To add one, add an entry to `src/variants.ts`. A variant can set options of
the model, options of the provider, `chimera run` flags, and a mode.

## Tasks

Fourteen tasks, in six categories. `list` prints what each one shows.

| Category | Tasks |
| --- | --- |
| `edit` | `edit-single-line`, `edit-multi-site`, `edit-tabs`, `edit-large-file`, `create-file` |
| `navigate` | `find-and-fix`, `answer-question` |
| `verify` | `fix-failing-test`, `fix-two-bugs` |
| `recover` | `ambiguous-edit`, `wrong-path` |
| `restrain` | `explain-only`, `scoped-change` |
| `build` | `add-feature` |

A task is a TypeScript object in `src/tasks/`: files, a prompt, a `check` and a
`solve`. `solve` applies a correct answer. The tests run each check on an
untouched workspace (it must fail) and after `solve` (it must pass), so a new
task needs both.

A check that runs tests writes its own test files first. A model cannot pass
by editing a test.

## Reading the results

The report has one line for each model and variant:

| Column | Meaning |
| --- | --- |
| `solved` | Runs that the check accepted. |
| `finished` | Runs that ended by themselves with `stop`: not at the step limit, the time limit, an error or a permission request. |
| `steps`, `seconds` | Medians. |
| `tool errors` | Failed tool calls, as a share of all tool calls. |
| `repeats` | Tool calls with the same name and arguments as the call before them. |
| `prompt` | Median input tokens of the first step: system prompt, tool schemas and the task. |

Below it are the solved runs of each task, and a list of the runs that were
not solved or did not finish. Each of those has a directory with
`events.ndjson`, `stderr.txt` and `changes.patch` (what the model changed).

Everything is in `packages/evals/.results/`, which git ignores: the evalite
database, one JSON export for each run, and the run directories.
`CHIMERA_EVALS_RESULTS_DIR` moves it.

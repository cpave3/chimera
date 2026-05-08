# Code-quality review: `packages/tools` & `packages/sandbox`

Severity tags: `[crit]` / `[high]` / `[med]` / `[low]`. Every finding cites a
verified `file:line`.

---

## Prior-findings status

The prior review (`chimera-findings-claude.md`) flagged four items in this
scope. Their current status:

| # | Prior finding | Status |
|---|---|---|
| 1 | `bash.ts` destructive patterns are a speed bump | **Unchanged** — see §1 below. |
| 2 | `docker-executor.ts` 434 lines, `buildRunArgs` tangled | **Unchanged** — file is now 461 lines; `buildRunArgs` still inline (~L188–241). |
| 3 | `--user` ID validation missing in `resolveHostId` | **Unchanged** — `resolveHostId` still accepts any `number`. |
| 4 | `docker-runner.ts` empty catch swallows EPERM | **Unchanged** — `try { child.kill(...) } catch {}` still present. |
| 5 | `toContainerPath` comment needed for absolute-path pass-through | **Fixed** — comment added at `docker-executor.ts:428–430`. |
| 6 | `toContainerPath` / `shellQuote` only tested via gated E2E | **Unchanged** — still no unit tests. |

---

## 1. `bash.ts` destructive-pattern list — still advisory, still undocumented as such

- `[med]` **`packages/tools/src/bash.ts:7–13`**

  The `DESTRUCTIVE_PATTERNS` regex list rejects `rm -rf /`, fork bombs, and
  direct `/etc` writes. It is trivially bypassed:
  `bash -c '$(rm -rf /)'`, `dd if=/dev/zero of=/etc/passwd`, here-docs,
  command substitutions, or simply `echo "rm -rf /" | sh`. The real safety
  net is the permission gate; this list is theatre.

  **Recommendation:** Either delete it entirely (it gives a false sense of
  defense-in-depth) or add a prominent comment at line 7 stating it is
  advisory-only and not a security boundary.

---

## 2. `glob.ts` — correctness & edge cases

- `[med]` **`packages/tools/src/glob.ts:29`**

  The `rg` command is built as:
  ```
  rg --files --hidden --glob '<pattern>' -- '<path>'
  ```
  `rg --files` lists *all* files matching `--glob`; it does not apply the
  glob as a search pattern. This is the correct invocation for a file-listing
  tool. `path` defaults to `.` when empty.

- `[low]` **`packages/tools/src/glob.ts:61–63`**

  `shellQuote` is duplicated verbatim in `grep.ts:133–135` and
  `docker-executor.ts:444–447`. A security-relevant quoting helper should
  live in one place.

- `[med]` **`packages/tools/src/glob.ts` — test coverage gaps**

  `glob-grep.test.ts` covers basic patterns, `path` filtering, and empty
  results. Missing branches:
  - Truncation at `MAX_FILES = 1000` (no test generates >1000 files).
  - `rg` exit code 127 (not installed) — only reachable when `rg` is absent;
    the test suite skips entirely in that case.
  - Pattern containing a single quote (shell-injection surface for the
    internal `shellQuote`).
  - Absolute `path` argument.

---

## 3. `grep.ts` — correctness & edge cases

- `[med]` **`packages/tools/src/grep.ts:48,61–62`**

  The per-file match cap uses `rg -m <limit+1>`. When `files_with_matches`
  is true, `-m` is omitted and `-l` is used; each matching file produces
  exactly one line, so total output is bounded by file count. Acceptable.

  For content mode, `rg -m limit+1` caps per-file matches, and the parsing
  loop breaks at `matches.length >= limit`. A single file can therefore
  briefly yield `limit+1` matches before truncation is reported. Multiple
  files with modest match counts could collectively push the total closer
  to `limit+1` before the break fires. This is bounded and acceptable, but
  worth a comment because the interaction between `rg -m` and the JS-level
  break is subtle.

  **More importantly:** when `args.pattern` is an empty string, `rg -e ''`
  matches every line in every file. The `-m limit+1` cap prevents any single
  file from dominating, but `rg` still has to open and scan *every* file in
  the tree before the JS parser can break. On a large repo this is an
  unnecessary O(n) scan. Consider rejecting empty patterns up-front.

- `[low]` **`packages/tools/src/grep.ts:117–131`**

  `parseRgLine` splits on the first two colons. If a file path itself
  contains colons (exotic filesystems), the split is wrong and the line is
  silently dropped. A comment at line 119 acknowledges this, but there is
  no TODO or tracking to fix it (e.g., using `rg --json` which quotes paths).

- `[med]` **`packages/tools/src/grep.ts` — test coverage gaps**

  Missing branches in `glob-grep.test.ts`:
  - `files_with_matches=true` with truncation (the `-m` omission path).
  - `max_count` clamped to `HARD_MAX_MATCHES` (no test supplies a huge
    `max_count`).
  - `rg` exit code 127 (same as glob — only tested when rg is absent).
  - Pattern with single quote (tests `shellQuote` round-trip).
  - Empty pattern (would catch the O(n) scan above).
  - Lines where content itself contains colons (exercises `parseRgLine`
    robustness).

---

## 4. `edit.ts` — `$`-pattern fix verified, diff rendering subtleties

- `[none]` **`packages/tools/src/edit.ts:51–55`**

  The `$`-sequence regression fix (commit 3035651) is present and correct:
  - `replace_all` uses `content.split(old).join(new)`.
  - Single replace uses string slicing (`slice` + `+`), avoiding
    `String.prototype.replace` entirely.

  Tests in `tools.test.ts:191–221` exercise `^name$`, `$&`, `$\``, `$'`, and
  `$$`. Good coverage.

- `[low]` **`packages/tools/src/edit.ts:100–119`**

  `linesBelow` computes `contextAfter` from the **post-edit** file. When a
  multi-line `old_string` ends with `\n` and the replacement does not, the
  next line is merged into the replacement line. `linesBelow` skips the
  remainder of the line the span landed inside (`suffix.indexOf('\n')`),
  so the merged remainder is dropped from `contextAfter`.

  Example: replace `b\n` -> `X` in `a\nb\nc\n`. Result is `a\nXc\n`.
  `contextAfter` returns `[]` instead of `['c']` because `c` is now on the
  same line as the replacement and gets skipped. This is a rendering
  inaccuracy, not a data-loss bug, and is unlikely to trigger in practice
  (the model rarely removes newlines with `edit`).

- `[low]` **`packages/tools/src/edit.ts:51`**

  `replace_all` branch with `$`-sequences lacks test coverage. The current
  test for `replace_all` (`tools.test.ts:223–237`) uses `'NEEDLE'` -> `'X'`;
  it does not exercise a `$`-literal under `replace_all`. The
  `split().join()` implementation is safe by construction, but a regression
  test would guard against a future refactor back to `replaceAll()`.

---

## 5. `docker-executor.ts` — still a monolith, still missing validation

- `[med]` **`packages/sandbox/src/docker-executor.ts:188–241`**

  `buildRunArgs` remains an inline string-array builder (~53 lines) inside
  a 461-line class. The prior review recommended extracting a small builder
  or splitting the class into `DockerImageManager` + `DockerContainerManager`.
  Neither has happened. The method is readable enough, but it still packs
  network, memory, CPU, bind/overlay/ephemeral mounts, and capability flags
  into one flat array push sequence. A dedicated `RunArgBuilder` would make
  order-of-flags mistakes impossible and the class easier to split later.

- `[med]` **`packages/sandbox/src/docker-executor.ts:453–461`**

  `resolveHostId` returns any `number` verbatim:
  ```ts
  if (typeof override === 'number') return override;
  ```
  No check for `NaN`, negative values, or non-integers. Passing
  `hostUid: -1` or `hostUid: 3.14` would reach `--user -1:5678` or
  `--user 3.14:5678` in the `docker exec` argv, which Docker rejects with
  an opaque error. Validate at construction:
  ```ts
  if (!Number.isFinite(override) || override < 0 || !Number.isInteger(override))
    throw new TypeError(...);
  ```

- `[med]` **`packages/sandbox/src/docker-executor.ts:421–435`** / **`packages/sandbox/src/docker-executor.ts:444–447`**

  `toContainerPath` and `shellQuote` are pure, security-relevant functions.
  They are only exercised by the gated Docker E2E suite
  (`CHIMERA_TEST_DOCKER=1`). There are no unit tests for path-translation
  edge cases (e.g., `hostCwd` with/without trailing slash, paths exactly
  equal to `hostCwd`, relative `.` and `..`, or `shellQuote` with single
  quotes, newlines, or ANSI sequences).

  `toContainerPath` now has a comment explaining the absolute-pass-through
  behavior (addressing the prior finding), but the test gap remains.

---

## 6. `docker-runner.ts` — empty catch still swallows EPERM

- `[med]` **`packages/sandbox/src/docker-runner.ts:97–99` and `101–103`**

  ```ts
  try {
    child.kill('SIGTERM');
  } catch {}
  ```
  (Same for `SIGKILL` fallback.)

  `child.kill` throws `ESRCH` (process already gone — benign) or `EPERM`
  (caller lacks permission to signal — a real problem). The empty catch
  treats both identically. The `local-executor.ts` has the same pattern at
  lines 174–177 and 180–183; the prior review flagged it there too.

  **Recommendation:** Log `EPERM` at debug, or at minimum narrow the catch
  to `if (err.code !== 'ESRCH') { /* log or rethrow */ }`.

---

## 7. `overlay.ts` — new fork/apply/diff logic

- `[med]` **`packages/sandbox/src/overlay.ts:170–183`**

  `applyOverlay` supports selective path syncing via `--include` / `--exclude`.
  It builds ancestor `--include` entries for each selected path:
  ```ts
  const parts = path.split('/');
  let acc = '';
  for (let i = 0; i < parts.length - 1; i += 1) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
    args.push('--include', `/${acc}/`);
  }
  args.push('--include', `/${path}`);
  args.push('--exclude', '*');
  ```

  This works for **file** paths (the only case tested in
  `overlay.test.ts:79–97`). For **directory** paths, e.g., `selection.paths =
  ['src/']`, the generated rules are `--include /src/` and `--exclude *`.
  In rsync filter logic, `--include /src/` matches the directory本身, but
  `--exclude *` then excludes every file *inside* `src/` because there is no
  wildcard include for descendants. The sync would produce an empty `src/`
  shell on the host.

  **Fix:** when the final path component is a directory (or ambiguous),
  append an additional `--include /${path}/**` before the `--exclude *`.

- `[low]` **`packages/sandbox/src/overlay.ts:106–135`**

  `parseRsyncItemize` skips any entry where `prefix[1] !== 'f'`. This drops
  symlinks, device files, etc. A file replaced by a symlink in the overlay
  would show as `*deleting oldfile` and `>L+++++++++ oldfile`; the second
  line is silently discarded, so the diff reports only a deletion, not a
  type change. Acceptable for a high-level diff view, but worth documenting
  in a comment.

- `[low]` **`packages/sandbox/src/overlay.ts:58–67`**

  `forkOverlay` tolerates rsync exit 23 as "nothing to copy".
  Rsync exit 23 is `partial transfer`; it can mean the source didn't exist,
  but it can *also* mean some files were unreadable due to permissions.
  Treating all exit-23 scenarios as silent success could mask a real sync
  failure during session fork.

  **Recommendation:** Distinguish the two cases. If stderr contains
  `"No such file or directory"` (source missing), tolerate it; otherwise
  treat exit 23 as an error.

- `[low]` **`packages/sandbox/src/overlay.ts:137–156`**

  `diffOverlay` runs `rsync --dry-run ... <upperData>/ <hostCwd>/`. There
  is no test for rsync returning exit 23 (source missing), though the
  caller (`forkOverlay`) handles it. `diffOverlay` throws on exit 23,
  which is correct for a diff operation.

---

## 8. Test coverage — summary of untested branches

| File | Branch / condition | Why it matters |
|---|---|---|
| `glob.ts` | `rg` exit 127 | Tool falls back to a helpful error message; never exercised in CI if `rg` is pre-installed. |
| `glob.ts` | Truncation at 1000 files | Only happy-path tested; no large tree fixture. |
| `grep.ts` | `files_with_matches` + truncation | `-m` is omitted; no test with >limit files. |
| `grep.ts` | `max_count` clamped to `HARD_MAX` | Always tested within default range. |
| `grep.ts` | Empty pattern `''` | Triggers an O(n) scan of every file; no rejection. |
| `edit.ts` | `replace_all` with `$`-literals | Safe by inspection, no regression test. |
| `docker-executor.ts` | `toContainerPath` edge cases | Pure security-relevant function; only E2E. |
| `docker-executor.ts` | `shellQuote` edge cases | Single quotes, newlines, null bytes; only E2E. |
| `docker-executor.ts` | `resolveHostId` with invalid numbers | `NaN`, negative, float; never exercised. |
| `overlay.ts` | `applyOverlay` with directory paths | Would silently sync empty directory shells. |
| `overlay.ts` | `forkOverlay` with actual files | Only mocks rsync args, not filesystem state. |

---

## Top 5 actionable recommendations

1. **Validate `hostUid`/`hostGid` in `resolveHostId`**
   (`docker-executor.ts:453–461`) — add a `Number.isFinite` /
   `Number.isInteger` / `>= 0` guard. Quick, blocks invalid CLI input.

2. **Extract `shellQuote` to a shared utility**
   (`tools/src/` or `core/src/`) — three copies of a security-relevant
   function is three places for a typo to hide.

3. **Fix `applyOverlay` directory-path filtering**
   (`overlay.ts:170–183`) — append `--include /${path}/**` when the path
   is a directory, or document the limitation.

4. **Add unit tests for `toContainerPath` and `shellQuote`**
   (`docker-executor.ts`) — pure functions with no Docker dependency;
   can be tested without `CHIMERA_TEST_DOCKER=1`.

5. **Document or remove `bash.ts` destructive-pattern guard**
   (`bash.ts:7–13`) — it reads as defense-in-depth but is trivially
   bypassed. A one-line comment avoids future false confidence.

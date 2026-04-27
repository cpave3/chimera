## 1. Buffer model (pure, no Ink)

- [x] 1.1 Create `packages/tui/src/input/buffer.ts` exporting
      `MultilineBuffer = { text: string; cursor: number }` and the pure
      operations: `insertChar`, `insertText`, `insertNewline`, `backspace`,
      `deleteForward`, `moveLeft`, `moveRight`, `moveLineStart`,
      `moveLineEnd`, `replaceAll`, plus helpers `cursorLineCol(buf)` and
      `lines(buf)`.
- [x] 1.2 Implement `moveUp` / `moveDown` with a sticky-column parameter
      (the operation takes the desired column as an arg; the caller owns
      the ref so multi-step navigation preserves the column).
- [x] 1.3 Add an `endsWithUnescapedBackslashAtCursor(buf)` predicate that
      returns `true` iff the character immediately before `cursor` is `\`
      and (per design) treats it as unescaped — there is no escape syntax
      in the prompt, so this is just `buf.text[buf.cursor - 1] === '\\'`.
- [x] 1.4 Write `packages/tui/test/input-buffer.test.ts` with vitest cases
      covering: insertChar at start/middle/end; insertNewline splitting a
      line; backspace at offset 0 (no-op); backspace across `\n` (joins
      lines); deleteForward at end (no-op); deleteForward across `\n`;
      moveLeft / moveRight crossing line boundaries; moveUp / moveDown
      with sticky column on uneven line lengths; moveLineStart /
      moveLineEnd; replaceAll resets cursor to text length.
- [x] 1.5 Verify `pnpm --filter @chimera/tui test input-buffer` passes
      with all cases green and no warnings.

## 2. External-editor handoff module

- [x] 2.1 Create `packages/tui/src/input/external-editor.ts` exporting a
      single async function
      `openInEditor(args: { initialText: string; mouseActive: boolean;
      stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream }): Promise<{
      ok: true; text: string } | { ok: false; reason: string }>`.
- [x] 2.2 Implement editor resolution: pick the first non-empty of
      `process.env.VISUAL`, `process.env.EDITOR`, then `'vi'`. Split on
      ASCII whitespace into `[command, ...args]`.
- [x] 2.3 Write the buffer to a temp file at
      `path.join(os.tmpdir(), 'chimera-prompt-' + process.pid + '-' +
      crypto.randomUUID() + '.md')`.
- [x] 2.4 Suspend Ink: write the SGR-mouse-disable sequence
      (`\x1b[?1006l\x1b[?1003l`) to stdout when `mouseActive` is true,
      call `stdin.setRawMode?.(false)`, and pause the input listener.
- [x] 2.5 Spawn the editor with `child_process.spawn(command, [...args,
      tempFile], { stdio: 'inherit' })` and await its `'exit'` event.
- [x] 2.6 Resume: drain any pending bytes on stdin (`stdin.read()` until
      it returns null), restore raw mode, re-emit the SGR-mouse-enable
      sequence if it was on (`\x1b[?1003h\x1b[?1006h`).
- [x] 2.7 On exit code `0`, read the file, strip up to one trailing
      newline, return `{ ok: true, text }`. On any non-zero exit code,
      missing file, or read error, return `{ ok: false, reason }`. Always
      `fs.unlink` the file in a `finally` block (swallow ENOENT).
- [x] 2.8 Write `packages/tui/test/external-editor.test.ts` using a
      stub editor — set `EDITOR` to a small node script via
      `process.execPath` that overwrites the temp file with known
      contents and exits 0; assert the function returns the contents.
      Add a second case where the stub exits 1 and assert the function
      returns `{ ok: false, ... }`. Add a third case where neither
      `EDITOR` nor `VISUAL` is set and the resolved command is `vi`
      (assert resolution only — don't actually spawn vi in CI).

## 3. Wire buffer + cursor into App.tsx

- [x] 3.1 Replace `const [input, setInputState] = useState('')` and the
      `inputRef` mirror in `packages/tui/src/App.tsx` with
      `const [buffer, setBuffer] = useState<MultilineBuffer>({ text: '',
      cursor: 0 })` plus a `bufferRef` mirror that mirrors the same
      object. Provide a `setBuffer` wrapper that writes through to the
      ref synchronously, mirroring the existing `setInput` pattern at
      `App.tsx:155-161`.
- [x] 3.2 Add a `stickyColRef = useRef<number | null>(null)` and clear
      it on any horizontal motion or text edit.
- [x] 3.3 Refactor `useInput` (`App.tsx:394-508`) to dispatch buffer
      operations:
      - `key.return && !key.shift && !key.meta` and the buffer does NOT
        end with `\` at the cursor → submit `bufferRef.current.text`.
      - `key.return` with trailing-`\`-at-cursor OR `key.shift` OR
        `key.meta` → call `insertNewline` (replacing trailing `\` if
        present, per spec).
      - `key.leftArrow` / `key.rightArrow` → `moveLeft` / `moveRight`,
        clear sticky col.
      - `key.upArrow` / `key.downArrow`:
        - if buffer empty → existing history recall path (unchanged
          semantics).
        - else → `moveUp` / `moveDown` using sticky col.
      - `key.ctrl && char === 'a'` / `key.ctrl && char === 'e'` →
        `moveLineStart` / `moveLineEnd`.
      - `key.backspace` → `backspace`; `key.delete` → `deleteForward`.
      - `key.ctrl && char === 'g'` → see step 4.
      - Any other printable char with no ctrl/meta → `insertChar(buf,
        char)`.
- [x] 3.4 Update the slash-menu predicates that previously read `input`
      (e.g. `App.tsx:218-260`) to read `buffer.text` and to gate on
      "buffer is single-line and starts with `/`". Multi-line buffers
      SHALL NOT show the slash menu.
- [x] 3.5 Update history recall to load the recalled string into a fresh
      buffer with `cursor = text.length`. Submission still pushes the
      raw `text` to `historyRef`.

## 4. `Ctrl+G` integration

- [x] 4.1 Pass the Ink render handle, the custom stdin reference, and a
      `mouseActive` ref from `mount.tsx` down into `<App>` props (or a
      lightweight context if cleaner) so `App.tsx` can call into the
      editor module.
- [x] 4.2 Wire the `Ctrl+G` branch in `useInput` to call
      `openInEditor({ initialText: bufferRef.current.text, mouseActive,
      stdout, stdin })` with `await`. While the promise is pending, set
      a `editorOpen` state guard so other input doesn't try to mutate
      the buffer.
- [x] 4.3 On `{ ok: true, text }`, replace the buffer via `replaceAll`
      and clear the sticky column.
- [x] 4.4 On `{ ok: false, reason }`, append a scrollback info entry
      with `scrollback.addInfo(\`editor: \${reason}\`)`, leave the
      buffer untouched, and refresh entries.
- [x] 4.5 After return, force a re-render (calling `setBuffer` to its
      current value is sufficient) and re-enable mouse mode if it was
      on before the handoff.

## 5. Cursor-aware rendering

- [x] 5.1 Replace the prompt block in `App.tsx:1307-1320` with a
      vertically-stacked `<Box flexDirection="column">` whose children
      are one `<Box>` per logical line. The first line gets the existing
      `> ` accent prefix; subsequent lines get `  ` (two spaces).
- [x] 5.2 Render the cursor by splitting the cursor's line into pre /
      at / post segments: `<Text>{pre}</Text><Text inverse>{atOrSpace}
      </Text><Text>{post}</Text>`. Lines that don't contain the cursor
      render as a plain `<Text>{line}</Text>`. When the cursor is at the
      end of a line, `atOrSpace` is a single space.
- [x] 5.3 Update the bottom hint StatusBar
      (`hintsLeft` in `App.tsx`) to include `\<Enter> newline · Ctrl+G
      editor` ahead of the existing hints. Confirm the line still fits
      on an 80-column terminal; if not, drop a less-critical hint to
      make room.

## 6. Tests for the Ink-level behavior

- [x] 6.1 Extend `packages/tui/test/slash-dispatch.test.tsx` (or add a
      new sibling `multiline.test.tsx`) using `ink-testing-library` and
      the existing `type()` / per-char-sleep helper:
      - Type `hello\\` then send `\r`; assert the rendered prompt now
        shows two lines and no message was sent.
      - Type `hello world` then `\r`; assert `client.send` was called
        with `'hello world'`.
      - Type `foo`, send `\x1b\r` (Alt+Enter); assert two-line render.
      - Type `line1\nline2` (via two `\<Enter>` sequences), press
        `\x1b[A` (Up); assert the cursor moved to the previous line by
        observing a re-rendered prompt with the cursor on line 1.
- [x] 6.2 Add a test that opens the external editor with a stub
      `EDITOR` script (the same pattern used by `external-editor.test`)
      mounted inside the Ink app: type `before`, send `\x07` (Ctrl+G),
      have the stub overwrite the file with `after\n`, await the
      promise, assert the prompt now renders `after`.
- [x] 6.3 Add a regression test asserting that bare `Up` with empty
      buffer still recalls history (existing behavior).

## 7. Build, lint, typecheck, docs

- [x] 7.1 Run `pnpm --filter @chimera/tui build` and confirm `tsup`
      succeeds with no new warnings.
- [x] 7.2 Run `pnpm -r test` and confirm all suites pass (the new
      tests plus all pre-existing ones).
- [x] 7.3 Run `pnpm fmt` and `pnpm lint`; fix any biome findings.
- [x] 7.4 Run `pnpm typecheck` and clean up any leaked compiled
      artifacts in `packages/tui/src/` per the AGENTS.md note.
- [x] 7.5 Update `README.md`'s TUI section with one paragraph on
      multi-line composition: list the three newline triggers and the
      `Ctrl+G` editor handoff.
- [ ] 7.6 Manually exercise the feature against a real terminal: type
      a multi-line message, submit it, verify it reaches the agent
      intact; press `Ctrl+G`, edit a draft in `vim`, save, confirm the
      buffer updates. Note the result in the implementation PR.

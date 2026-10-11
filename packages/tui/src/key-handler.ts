import type { Checkpoint, SessionInfo } from '@chimera/core';
import type { Key } from 'ink';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AppProps } from './App';
import { acceptCompletion, type CompletionContext } from './file-completion';
import {
  backspace,
  endsWithUnescapedBackslashAtCursor,
  insertChar,
  insertNewline,
  type MultilineBuffer,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
} from './input/buffer';
import type { OverlayDiffEntry } from './OverlayPicker';
import type { PendingPermission } from './permission-queue';
import type { SlashMenuItem } from './SlashMenu';
import type { Scrollback } from './scrollback';
import { BUILTIN_COMMANDS } from './slash-commands';
import type { TranscriptScroller } from './view';

/** What a key press may read and change in the App. */
export interface KeyContext {
  props: AppProps;
  scrollback: Scrollback;
  running: boolean;
  /** The permission request at the head of the queue, if any. */
  pending: PendingPermission | null;
  activeModeName: string;
  pendingModeName: string | null;
  overlayPicker: OverlayDiffEntry[] | null;
  sessionPicker: SessionInfo[] | null;
  rewindPicker: Checkpoint[] | null;
  menuItems: SlashMenuItem[];
  menuOpen: boolean;
  menuHighlight: number;
  setMenuHighlight: Dispatch<SetStateAction<number>>;
  setMenuDismissed: Dispatch<SetStateAction<boolean>>;
  lastCtrlC: number;
  setLastCtrlC: Dispatch<SetStateAction<number>>;
  helpOpen: boolean;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  bufferRef: MutableRefObject<MultilineBuffer>;
  setBuffer: (next: MultilineBuffer | ((old: MultilineBuffer) => MultilineBuffer)) => void;
  setBufferText: (text: string) => void;
  stickyColRef: MutableRefObject<number | null>;
  historyRef: MutableRefObject<string[]>;
  historyIdxRef: MutableRefObject<number>;
  editorOpenRef: MutableRefObject<boolean>;
  interruptRun: () => void;
  cleanupAndExit: () => Promise<void>;
  runEditorHandoff: () => Promise<void>;
  runTranscriptView: () => Promise<void>;
  handleSubmit: (text: string) => Promise<void>;
  handleSlash: (raw: string) => void;
  handlePasteImage: () => Promise<void>;
  /** Messages held for the next turn. */
  queue: string[];
  setQueue: Dispatch<SetStateAction<string[]>>;
  /** The `@`/`#` word under the cursor and the files offered for it. */
  fileContext: CompletionContext | null;
  fileMenuItems: string[];
  fileMenuHighlight: number;
  setFileMenuHighlight: Dispatch<SetStateAction<number>>;
  /** Records the word the menu was closed on, so it stays closed for that word. */
  setFileMenuDismissedAt: Dispatch<SetStateAction<number | null>>;
  /** The layout owns the screen: the transcript scrolls and the panel toggles. */
  fullscreen: boolean;
  scrollerRef: MutableRefObject<TranscriptScroller | null>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
}

/** Handle one key press at the prompt. */
export function handleKey(char: string, key: Key, context: KeyContext): void {
  const {
    props,
    scrollback,
    running,
    pending,
    activeModeName,
    pendingModeName,
    overlayPicker,
    sessionPicker,
    rewindPicker,
    menuItems,
    menuOpen,
    menuHighlight,
    setMenuHighlight,
    setMenuDismissed,
    lastCtrlC,
    setLastCtrlC,
    helpOpen,
    setHelpOpen,
    bufferRef,
    setBuffer,
    setBufferText,
    stickyColRef,
    historyRef,
    historyIdxRef,
    editorOpenRef,
    interruptRun,
    cleanupAndExit,
    runEditorHandoff,
    runTranscriptView,
    handleSubmit,
    handleSlash,
    handlePasteImage,
    queue,
    setQueue,
    fileContext,
    fileMenuItems,
    fileMenuHighlight,
    setFileMenuHighlight,
    setFileMenuDismissedAt,
    fullscreen,
    scrollerRef,
    setPanelOpen,
  } = context;
  // The transcript scrolls under a dialog too: the user may want to read
  // what led to a permission request before answering it.
  if (fullscreen && (key.pageUp || key.pageDown)) {
    scrollerRef.current?.scrollPages(key.pageUp ? -1 : 1);
    return;
  }
  if (pending) return; // handled by modal
  if (overlayPicker) return; // handled by picker
  if (sessionPicker) return; // handled by SessionPicker
  if (rewindPicker) return; // handled by RewindPicker
  if (editorOpenRef.current) return; // editor is mid-handoff

  if (key.ctrl && char === 'c') {
    if (running) {
      interruptRun();
      return;
    }
    const now = Date.now();
    if (now - lastCtrlC < 2000) {
      void cleanupAndExit();
      return;
    }
    setLastCtrlC(now);
    scrollback.addInfo('press Ctrl+C again to exit');
    return;
  }
  if (helpOpen) {
    setHelpOpen(false);
    if (key.escape || char === '?') return;
  } else if (char === '?' && !key.ctrl && !key.meta && bufferRef.current.text === '') {
    setHelpOpen(true);
    return;
  }
  if (fileContext && fileMenuItems.length > 0) {
    const selected = Math.min(fileMenuHighlight, fileMenuItems.length - 1);
    if (key.escape) {
      setFileMenuDismissedAt(fileContext.start);
      return;
    }
    if (key.upArrow) {
      setFileMenuHighlight(Math.max(0, selected - 1));
      return;
    }
    if (key.downArrow) {
      setFileMenuHighlight(Math.min(fileMenuItems.length - 1, selected + 1));
      return;
    }
    if (key.tab || key.return) {
      setBuffer((buffer) => acceptCompletion(buffer, fileContext, fileMenuItems[selected]!));
      stickyColRef.current = null;
      return;
    }
  }
  if (key.escape && running && !menuOpen) {
    interruptRun();
    return;
  }
  if (key.ctrl && char === 'd') {
    void cleanupAndExit();
    return;
  }
  if (key.ctrl && char === 'z') {
    if (process.platform === 'win32') {
      // Windows doesn't support SIGTSTP; ignore the key.
      return;
    }
    process.kill(process.pid, 'SIGTSTP');
    return;
  }

  if (key.shift && key.tab) {
    // When `cycleModes` isn't supplied, default to every discovered
    // mode so user-authored files (e.g. ~/.chimera/modes/question.md)
    // are picked up automatically — see add-modes design D9.
    const all = props.modes?.all() ?? [];
    const cycle = props.cycleModes ?? all.map((mode) => mode.name);
    // Modes with cycle: false are excluded from Shift+Tab but remain
    // selectable via /mode <name>.
    const validCycle = cycle.filter((name) => {
      const mode = all.find((m) => m.name === name);
      return mode != null && mode.cycle !== false;
    });
    if (validCycle.length === 0) return;
    const here = pendingModeName ?? activeModeName;
    const idx = validCycle.indexOf(here);
    const nextName = validCycle[(idx + 1) % validCycle.length] ?? validCycle[0]!;
    void handleSlash(`/mode ${nextName}`);
    return;
  }

  const latestBuffer = bufferRef.current;
  const latestText = latestBuffer.text;

  if (menuOpen) {
    if (key.escape) {
      setMenuDismissed(true);
      return;
    }
    if (key.upArrow) {
      setMenuHighlight((h) => Math.max(0, h - 1));
      return;
    }
    if (key.downArrow) {
      setMenuHighlight((h) => Math.min(menuItems.length - 1, h + 1));
      return;
    }
    if (key.tab) {
      const sel = menuItems[menuHighlight];
      if (sel) setBufferText(`/${sel.name} `);
      return;
    }
    if (key.return) {
      const sel = menuItems[menuHighlight];
      if (!sel || latestText === `/${sel.name}`) {
        // fall through to submit below
      } else {
        setBufferText(`/${sel.name} `);
        return;
      }
    }
  }

  if (key.ctrl && char === 't') {
    void runTranscriptView();
    return;
  }
  if (fullscreen && key.ctrl && char === 'b') {
    setPanelOpen((open) => !open);
    return;
  }
  if (key.ctrl && char === 'g') {
    void runEditorHandoff();
    return;
  }
  if (key.ctrl && char === 'v') {
    void handlePasteImage();
    return;
  }

  if (key.return) {
    const insertNewlineKey =
      key.shift || key.meta || endsWithUnescapedBackslashAtCursor(latestBuffer);
    if (insertNewlineKey) {
      setBuffer((b) => insertNewline(b));
      stickyColRef.current = null;
      return;
    }
    if (latestText.trim().length === 0) return;
    const text = latestText;
    setBufferText('');
    historyRef.current.push(text);
    historyIdxRef.current = historyRef.current.length;
    void handleSubmit(text);
    return;
  }
  if (key.upArrow) {
    if (latestText.length === 0 && queue.length > 0) {
      // The newest queued message comes back for editing before history does.
      setBufferText(queue.at(-1)!);
      setQueue((queued) => queued.slice(0, -1));
      return;
    }
    if (latestText.length === 0) {
      if (historyRef.current.length === 0) return;
      historyIdxRef.current = Math.max(0, historyIdxRef.current - 1);
      setBufferText(historyRef.current[historyIdxRef.current] ?? '');
      return;
    }
    const { buf, col } = moveUp(latestBuffer, stickyColRef.current);
    stickyColRef.current = col;
    setBuffer(buf);
    return;
  }
  if (key.downArrow) {
    if (latestText.length === 0) {
      historyIdxRef.current = Math.min(historyRef.current.length, historyIdxRef.current + 1);
      setBufferText(historyRef.current[historyIdxRef.current] ?? '');
      return;
    }
    const { buf, col } = moveDown(latestBuffer, stickyColRef.current);
    stickyColRef.current = col;
    setBuffer(buf);
    return;
  }
  if (key.leftArrow) {
    stickyColRef.current = null;
    setBuffer((b) => moveLeft(b));
    return;
  }
  if (key.rightArrow) {
    stickyColRef.current = null;
    setBuffer((b) => moveRight(b));
    return;
  }
  if (key.ctrl && char === 'a') {
    stickyColRef.current = null;
    setBuffer((b) => moveLineStart(b));
    return;
  }
  if (key.ctrl && char === 'e') {
    stickyColRef.current = null;
    setBuffer((b) => moveLineEnd(b));
    return;
  }
  if (key.tab && running && !latestText.startsWith('/') && latestText.trim() !== '') {
    // Enter steers the run in progress; Tab holds the message for the next turn.
    setQueue((queued) => [...queued, latestText]);
    setBufferText('');
    return;
  }
  if (key.tab && latestText.startsWith('/') && !latestText.includes('\n')) {
    const match = BUILTIN_COMMANDS.find((c) => c.name.startsWith(latestText));
    if (match) {
      setBufferText(match.name);
      return;
    }
    const userMatch = props.commands?.list().find((c) => `/${c.name}`.startsWith(latestText));
    if (userMatch) {
      setBufferText(`/${userMatch.name}`);
      return;
    }
    const skillMatch = props.skills?.all().find((s) => `/${s.name}`.startsWith(latestText));
    if (skillMatch) setBufferText(`/${skillMatch.name}`);
    return;
  }
  if (key.backspace || key.delete) {
    // Ink's keypress parser maps `\x7f` (the modern Backspace key) to
    // `key.delete` and `\x08` (legacy / Ctrl+H) to `key.backspace`. The
    // physical Delete key (`[3~`) also lands on `key.delete`, so we can't
    // reliably distinguish it from Backspace — both behave as
    // "delete the char before the cursor", matching the convention used
    // elsewhere in the TUI (e.g. `PermissionModal`).
    stickyColRef.current = null;
    setBuffer((b) => backspace(b));
    return;
  }
  if (char && !key.ctrl && !key.meta) {
    stickyColRef.current = null;
    setBuffer((b) => insertChar(b, char));
  }
}

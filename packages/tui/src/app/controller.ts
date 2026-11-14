import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ChimeraClient, ChimeraHttpError } from '@chimera/client';
import type {
  AgentEvent,
  Checkpoint,
  PermissionDecisionAction,
  QuestionRequest,
  QuestionResolution,
  SessionId,
  SessionInfo,
  SessionStatus,
} from '@chimera/core';
import { describeActivity } from '../activity';
import { parseAttachTokens, readForAttach } from '../attach-paths';
import { runBangCommand } from '../bang';
import type { Card } from '../cards/card';
import { completeSlashPrefix, type SlashMenuItem, slashMenuItems } from '../cards/menus';
import { PermissionCard } from '../cards/permission-card';
import { QuestionCard } from '../cards/question-card';
import {
  HelpCard,
  type OverlayChange,
  OverlayPickerCard,
  RewindPickerCard,
  renderMenuCard,
  SessionPickerCard,
  SudoCard,
} from '../cards/simple-cards';
import { isImageFile, readClipboardImage, saveImageToSession } from '../clipboard';
import {
  acceptCompletion,
  completionContext,
  listProjectFiles,
  rankFiles,
} from '../file-completion';
import { type OpenInEditorResult, openFileInEditor, openInEditor } from '../input/external-editor';
import { openInPager } from '../input/pager';
import { PasteRegistry } from '../input/paste';
import { renderPromptBox } from '../ledger/prompt-box';
import { PromptEditor } from '../ledger/prompt-editor';
import { label, type RowContext, renderBanner, renderTaskRow } from '../ledger/rows';
import { StatusLineCommand } from '../ledger/status-command';
import {
  buildStatusPayload,
  DEFAULT_STATUS_ROWS,
  renderStatusLine,
  type StatusFacts,
  type StatusLine,
} from '../ledger/status-line';
import { BODY_INDENT } from '../ledger/text';
import type { NotificationReason } from '../notify';
import {
  mergePermissionQueue,
  type PendingPermission,
  requiresSudoAuthentication,
} from '../permission-queue';
import { previewLine } from '../preview-line';
import { Scrollback, type ScrollbackEntry, type SubagentEntry } from '../scrollback';
import {
  type ActiveSubagent,
  applySessionEvent,
  type SessionHydrationState,
  type UsageState,
} from '../session-events';
import { buildSessionTreeRows, formatRelativeTime } from '../session-tree';
import { isBuiltin } from '../slash-commands';
import { type ActiveSession, dispatchSlash } from '../slash-dispatch';
import type { Setter } from '../state';
import type { InputEvent, KeyEvent } from '../terminal/keys';
import { clipToWidth } from '../terminal/width';
import type { Style } from '../theme/style';
import { formatTranscript } from '../transcript-text';
import { readWorktree, type WorktreeStatus } from '../worktree';
import type { TuiOptions } from './options';

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;
const FILE_MENU_ROWS = 6;
const FILE_LIST_MAX_AGE_MS = 5_000;
const DOUBLE_CTRL_C_MS = 2_000;
const WORKTREE_SETTLE_MS = 400;
const MAX_QUEUED_ROWS = 3;
/** Rows of transcript a card leaves in view, at least. */
const MIN_TRANSCRIPT_ROWS = 3;

export interface SudoAuthenticationState {
  item: PendingPermission;
  action: PermissionDecisionAction;
  status: 'checking' | 'password' | 'validating';
  error?: string;
}

/** What the controller asks of the screen around it. */
export interface ControllerHooks {
  /** Something on screen changed: draw a frame soon. */
  requestRender(): void;
  /** Leave the TUI. */
  exit(): void;
  /** Run a program that takes the terminal over: an editor or a pager. */
  handoff<T>(operation: () => Promise<T>): Promise<T>;
  /** Ctrl+Z. */
  suspend(): void;
  notify(reason: NotificationReason, detail: { runMs: number }): void;
  /** Throw away what the screen shows of the transcript: after `/clear` and session switches. */
  transcriptReset(): void;
  /** Reload the theme after `/theme <name>`. */
  reloadTheme(): void;
}

/** What the layout lets the controller do with the transcript's scroll position. */
export interface TranscriptScroller {
  scrollBy(lines: number): void;
  scrollPages(pages: number): void;
  toTop(): void;
  toEnd(): void;
}

/**
 * What the top border says the run is doing, when it is waiting on
 * something other than the model: the tool rows already show the rest.
 */
function activityLabel(controller: TuiController): string | undefined {
  const label = describeActivity({
    awaitingApproval: controller.pending !== null,
    awaitingAnswer: controller.question !== null,
    compacting: controller.compacting,
    retry: controller.retry,
    inFlightTool: null,
    streaming: true,
  });
  return label === 'writing' ? undefined : label;
}

function sessionHasActiveRun(status: SessionStatus): boolean {
  return status === 'running' || status === 'waiting_for_permission';
}

function isActiveRunConflict(error: unknown): error is ChimeraHttpError {
  return (
    error instanceof ChimeraHttpError &&
    error.status === 409 &&
    typeof error.body === 'object' &&
    error.body !== null &&
    'error' in error.body &&
    error.body.error === 'run already in progress'
  );
}

/**
 * The TUI's controller: session events, run state, key handling and slash
 * commands, with all state in plain fields. Layouts draw what it holds and
 * hand it every input event; each handler reads the current state, so keys
 * typed in a burst act in order.
 */
export class TuiController {
  readonly scrollback: Scrollback;
  readonly editor: PromptEditor;
  readonly pastes = new PasteRegistry();
  scroller: TranscriptScroller | null = null;

  activeSession: ActiveSession;
  activeParentId: SessionId | null = null;
  permissionQueue: PendingPermission[] = [];
  questionQueue: QuestionRequest[] = [];
  sudoAuthentication: SudoAuthenticationState | null = null;
  running = false;
  compacting = false;
  bangRunning = false;
  streaming = false;
  activeModeName: string;
  pendingModeName: string | null = null;
  currentModelRef: string;
  visionRouteRef: string | null = null;
  retry: { attempt: number; maxAttempts: number } | null = null;
  runSteps = 0;
  queue: string[] = [];
  pendingImages: string[] = [];
  usageState: UsageState | null = null;
  tasks: { content: string; status: string }[] = [];
  goal: string | null = null;
  overlayPicker: OverlayChange[] | null = null;
  sessionPicker: SessionInfo[] | null = null;
  rewindPicker: Checkpoint[] | null = null;
  helpOpen = false;
  editorOpen = false;
  showBanner = true;
  /** Ctrl+O: every tool output and thinking block in full. */
  expandAll = false;
  /** Entries clicked open or shut, against `expandAll`. */
  readonly expandedOverrides = new Map<string, boolean>();
  spinnerFrame = 0;
  runStartedAt: number | null = null;
  worktree: WorktreeStatus | null = null;
  /** A short notice for the prompt box's top border, such as a copy confirmation. */
  notice: string | null = null;
  /** The updater's notice for the status line and the transcript. */
  updateNotice: string | null = null;

  private menuHighlight = 0;
  private menuDismissed = false;
  private fileMenuHighlight = 0;
  private fileMenuDismissedAt: number | null = null;
  private projectFiles: string[] = [];
  private projectFilesLoadedAt = 0;
  private lastCtrlC = 0;
  private interrupted = false;
  private runElapsed = 0;
  private hydration: SessionHydrationState = {
    lifecycleEventObserved: false,
    resolvedPermissionIds: new Set(),
  };
  private readonly hydrationRef: { current: SessionHydrationState };
  private readonly subagents = { current: new Map<string, ActiveSubagent>() };
  private subscription: AbortController | null = null;
  private sudoController: AbortController | null = null;
  private spinnerTimer: NodeJS.Timeout | undefined;
  private worktreeTimer: NodeJS.Timeout | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private statusCommand: StatusLineCommand | null = null;
  private statusCommandLines: string[] = [];
  private unsubscribeCommands: (() => void) | undefined;
  private unsubscribeScrollback: (() => void) | undefined;
  private wasBusy = false;
  private wasRunning = false;
  private lastPermissionId: string | null = null;
  private lastQuestionId: string | null = null;
  private cards = new Map<string, Card>();
  private disposed = false;
  columns = 80;

  constructor(
    readonly options: TuiOptions,
    private readonly hooks: ControllerHooks,
    readonly fullscreen: boolean,
  ) {
    this.scrollback = new Scrollback(options.formatters);
    this.editor = new PromptEditor(this.pastes);
    this.activeSession = { client: options.client, sessionId: options.sessionId, label: 'parent' };
    this.activeModeName = options.initialMode ?? 'build';
    this.currentModelRef = options.modelRef;
    this.hydrationRef = { current: this.hydration };
  }

  // ---------- state ----------

  private setter<K extends keyof this>(key: K): Setter<this[K]> {
    return (next) => {
      const value =
        typeof next === 'function' ? (next as (current: this[K]) => this[K])(this[key]) : next;
      if (value === this[key]) return;
      this[key] = value;
      this.changed();
    };
  }

  /** State changed: follow-on effects, then a frame. */
  changed(): void {
    if (this.disposed) return;
    const busy = this.busy;
    if (this.wasBusy && !busy && this.queue.length > 0) void this.drainQueue();
    this.wasBusy = busy;
    if (this.running && this.runStartedAt === null) this.runStartedAt = Date.now();
    if (this.running || this.compacting) {
      if (this.runStartedAt === null) this.runStartedAt = Date.now();
    } else if (this.runStartedAt !== null) {
      this.runElapsed = Date.now() - this.runStartedAt;
      this.runStartedAt = null;
    }
    if (this.wasRunning && !this.running && !this.interrupted) {
      this.hooks.notify('run_finished', { runMs: this.runElapsed });
    }
    if (!this.running) this.interrupted = false;
    if (this.wasRunning && !this.running) this.scheduleWorktree();
    this.wasRunning = this.running;
    const permissionId = this.permissionQueue[0]?.requestId ?? null;
    if (permissionId !== null && permissionId !== this.lastPermissionId)
      this.hooks.notify('approval', { runMs: 0 });
    this.lastPermissionId = permissionId;
    const questionId = this.questionQueue[0]?.requestId ?? null;
    if (questionId !== null && questionId !== this.lastQuestionId)
      this.hooks.notify('input', { runMs: 0 });
    this.lastQuestionId = questionId;
    this.syncSpinner();
    this.hooks.requestRender();
  }

  get busy(): boolean {
    return this.running || this.compacting || this.bangRunning;
  }

  get sandboxLabel(): string {
    const mode = this.options.sandboxMode ?? 'off';
    return mode === 'off' && this.options.osSandbox ? 'os' : mode;
  }

  // ---------- lifecycle ----------

  start(): void {
    for (const notice of this.options.startupNotices ?? []) this.scrollback.addInfo(notice);
    const commands = this.options.commands;
    if (commands) {
      for (const collision of commands.collisions()) {
        this.scrollback.addInfo(
          `warning: command "${collision.name}" at ${collision.loserPath} is shadowed by ${collision.winnerPath}`,
        );
      }
      for (const command of commands.list()) {
        if (isBuiltin(`/${command.name}`)) {
          this.scrollback.addInfo(
            `warning: user command /${command.name} is shadowed by the built-in of the same name`,
          );
        }
      }
      this.unsubscribeCommands = commands.onChange?.(() => {
        this.scrollback.addInfo(`commands reloaded (${commands.list().length} total)`);
        this.changed();
      });
    }
    this.unsubscribeScrollback = this.scrollback.subscribe(() => this.hooks.requestRender());
    if (this.options.statusLine?.command) {
      this.statusCommand = new StatusLineCommand({
        command: this.options.statusLine.command,
        cwd: this.options.cwd,
        onOutput: (lines) => {
          this.statusCommandLines = lines;
          this.hooks.requestRender();
        },
      });
    }
    this.switchedSession();
    this.scheduleWorktree(0);
    if (this.options.initialPrompt) void this.handleSubmit(this.options.initialPrompt);
  }

  dispose(): void {
    this.disposed = true;
    this.subscription?.abort();
    this.sudoController?.abort();
    clearInterval(this.spinnerTimer);
    clearTimeout(this.worktreeTimer);
    clearTimeout(this.noticeTimer);
    this.statusCommand?.dispose();
    this.unsubscribeCommands?.();
    this.unsubscribeScrollback?.();
    if (this.cards.size > 0)
      for (const card of this.cards.values()) (card as { dispose?: () => void }).dispose?.();
  }

  private syncSpinner(): void {
    const spinning = this.running || this.compacting;
    if (spinning && !this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.hooks.requestRender();
      }, SPINNER_INTERVAL_MS);
      this.spinnerTimer.unref?.();
    } else if (!spinning && this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  private scheduleWorktree(delay = WORKTREE_SETTLE_MS): void {
    clearTimeout(this.worktreeTimer);
    this.worktreeTimer = setTimeout(() => {
      void (this.options.readWorktree ?? readWorktree)(this.options.cwd).then(
        (status) => {
          if (this.disposed) return;
          this.worktree = status;
          this.updateStatusCommand();
          this.hooks.requestRender();
        },
        () => {},
      );
    }, delay);
    this.worktreeTimer.unref?.();
  }

  /** Subscribe to the active session and load what it holds. */
  private switchedSession(): void {
    this.subscription?.abort();
    const hydration: SessionHydrationState = {
      lifecycleEventObserved: false,
      resolvedPermissionIds: new Set(),
    };
    this.hydration = hydration;
    this.hydrationRef.current = hydration;
    this.running = false;
    this.permissionQueue = [];
    this.questionQueue = [];
    this.sudoController?.abort();
    this.sudoController = null;
    this.sudoAuthentication = null;
    const session = this.activeSession;
    const controller = new AbortController();
    this.subscription = controller;
    void (async () => {
      try {
        for await (const event of session.client.subscribe(session.sessionId, {
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          this.apply(event);
        }
      } catch (err) {
        if (!controller.signal.aborted)
          this.scrollback.addError(`event stream error: ${(err as Error).message}`);
      }
    })();
    void (async () => {
      try {
        const info = await session.client.getSession(session.sessionId);
        if (controller.signal.aborted) return;
        this.activeParentId = info.parentId ?? null;
        if (!hydration.lifecycleEventObserved) this.running = sessionHasActiveRun(info.status);
        this.permissionQueue = mergePermissionQueue(
          this.permissionQueue,
          (info.pendingPermissions ?? []).filter(
            (request) => !hydration.resolvedPermissionIds.has(request.requestId),
          ),
        );
        this.questionQueue = [
          ...this.questionQueue,
          ...(info.pendingQuestions ?? []).filter(
            (request) =>
              !this.questionQueue.some((queued) => queued.requestId === request.requestId),
          ),
        ];
        this.activeModeName = info.mode;
        this.currentModelRef = `${info.model.providerId}/${info.model.modelId}`;
        const sessionTasks = (info as { tasks?: { content: string; status: string }[] }).tasks;
        this.tasks = Array.isArray(sessionTasks) ? sessionTasks : [];
        this.goal = info.goal?.condition ?? null;
        if (Array.isArray(info.messages) && info.messages.length > 0)
          this.scrollback.rehydrateFromSession(info);
      } catch {
        if (!controller.signal.aborted) this.activeParentId = null;
      }
      this.changed();
    })();
    this.changed();
  }

  apply(event: AgentEvent | { type: 'permission_timeout'; requestId: string }): void {
    applySessionEvent(event, {
      scrollback: this.scrollback,
      sessionHydrationRef: this.hydrationRef,
      subagentsRef: this.subagents,
      setRunning: this.setter('running'),
      setStreaming: this.setter('streaming'),
      setPermissionQueue: this.setter('permissionQueue'),
      setVisionRouteRef: this.setter('visionRouteRef'),
      setUsageState: this.setter('usageState'),
      setActiveModeName: this.setter('activeModeName'),
      setPendingModeName: this.setter('pendingModeName'),
      setCurrentModelRef: this.setter('currentModelRef'),
      setCompacting: this.setter('compacting'),
      setTasks: this.setter('tasks'),
      setGoal: this.setter('goal'),
      setRetry: this.setter('retry'),
      setRunSteps: this.setter('runSteps'),
      onInputRequired: () => this.hooks.notify('input', { runMs: 0 }),
      setQuestionQueue: this.setter('questionQueue'),
    });
    if (event.type !== 'assistant_text_delta' && event.type !== 'reasoning_text_delta')
      this.updateStatusCommand();
    this.changed();
  }

  // ---------- what is on screen ----------

  get pending(): PendingPermission | null {
    return this.permissionQueue[0] ?? null;
  }

  get question(): QuestionRequest | null {
    return this.questionQueue[0] ?? null;
  }

  /** The card with the keyboard, if any: the most urgent first. */
  modalCard(): Card | null {
    const cached = <T extends Card>(key: string, create: () => T): T => {
      let card = this.cards.get(key) as T | undefined;
      if (!card) {
        card = create();
        this.cards.set(key, card);
      }
      return card;
    };
    let card: Card | null = null;
    let key = '';
    if (this.sudoAuthentication) {
      key = `sudo:${this.sudoAuthentication.item.requestId}`;
      card = cached(
        key,
        () =>
          new SudoCard(
            () => this.sudoAuthentication ?? { status: 'checking' },
            (password) => void this.submitSudoPassword(password),
            () => this.cancelSudoAuthentication(),
          ),
      );
    } else if (this.pending) {
      const request = this.pending;
      key = `permission:${request.requestId}`;
      card = cached(key, () => new PermissionCard(request, (action) => this.onResolve(action)));
    } else if (this.question) {
      const request = this.question;
      key = `question:${request.requestId}`;
      card = cached(
        key,
        () => new QuestionCard(request, (resolution) => this.answerQuestion(resolution)),
      );
    } else if (this.overlayPicker) {
      const changes = this.overlayPicker;
      key = 'overlay';
      card = cached(
        key,
        () => new OverlayPickerCard(changes, (selection) => this.applyOverlaySelection(selection)),
      );
    } else if (this.sessionPicker) {
      const sessions = this.sessionPicker;
      key = 'sessions';
      card = cached(
        key,
        () =>
          new SessionPickerCard(
            buildSessionTreeRows(sessions),
            this.activeSession.sessionId,
            (id) => this.selectSession(id),
            () => this.cancelSessionPicker(),
            Date.now,
            formatRelativeTime,
          ),
      );
    } else if (this.rewindPicker) {
      const checkpoints = this.rewindPicker;
      key = 'rewind';
      card = cached(
        key,
        () =>
          new RewindPickerCard(
            checkpoints,
            (checkpoint) => this.rewindTo(checkpoint),
            (checkpoint) => this.forkFrom(checkpoint),
            () => this.cancelRewind(),
          ),
      );
    }
    // A card that closed starts fresh the next time.
    for (const [cardKey, stale] of this.cards) {
      if (cardKey !== key) {
        (stale as { dispose?: () => void }).dispose?.();
        this.cards.delete(cardKey);
      }
    }
    return card;
  }

  get menuItems(): SlashMenuItem[] {
    if (this.menuDismissed) return [];
    return slashMenuItems(this.editor.buffer.text, {
      commands: this.options.commands,
      skills: this.options.skills,
      overlay: this.options.sandboxMode === 'overlay',
    });
  }

  private get fileContext() {
    return completionContext(this.editor.buffer);
  }

  get fileMenuItems(): string[] {
    const context = this.fileContext;
    if (!context || this.fileMenuDismissedAt === context.start) return [];
    if (Date.now() - this.projectFilesLoadedAt > FILE_LIST_MAX_AGE_MS) {
      this.projectFilesLoadedAt = Date.now();
      void (this.options.listFiles ?? listProjectFiles)(this.options.cwd).then(
        (files) => {
          this.projectFiles = files;
          this.hooks.requestRender();
        },
        () => {},
      );
    }
    return rankFiles(this.projectFiles, context.query, FILE_MENU_ROWS);
  }

  isExpanded(entryId: string): boolean {
    return this.expandedOverrides.get(entryId) ?? this.expandAll;
  }

  /** Click on an entry: show or hide just its detail. */
  toggleEntry(entryId: string): void {
    this.expandedOverrides.set(entryId, !this.isExpanded(entryId));
    this.changed();
  }

  get spinner(): string {
    return SPINNER_FRAMES[this.spinnerFrame]!;
  }

  /** The entries to draw, with the subagent rows grouped under their spawn. */
  transcript(): { entries: ScrollbackEntry[]; children: Map<string, SubagentEntry[]> } {
    const entries = this.scrollback.all();
    const children = new Map<string, SubagentEntry[]>();
    for (const entry of entries) {
      if (entry.kind === 'subagent' && entry.parentEntryId) {
        const list = children.get(entry.parentEntryId) ?? [];
        list.push(entry);
        children.set(entry.parentEntryId, list);
      }
    }
    return { entries, children };
  }

  rowContext(width: number, style: Style, children: Map<string, SubagentEntry[]>): RowContext {
    return {
      width,
      style,
      spinner: this.spinner,
      sandboxActive: (this.options.sandboxMode ?? 'off') !== 'off',
      isExpanded: (entryId) => this.isExpanded(entryId),
      children,
    };
  }

  banner(width: number, style: Style): string[] {
    if (!this.showBanner) return [];
    return renderBanner(
      {
        version: this.options.version ?? 'dev',
        modelRef: this.options.modelRef,
        cwd: this.options.cwd,
        skillCount: this.options.skills?.all().length ?? 0,
        commandCount: this.options.commands?.list().length ?? 0,
      },
      width,
      style,
    );
  }

  statusFacts(): StatusFacts {
    return {
      modelRef: this.currentModelRef,
      visionRouteRef: this.visionRouteRef,
      usage: this.usageState,
      cwd: this.options.cwd,
      branch: this.worktree
        ? { name: this.worktree.branch, ahead: this.worktree.ahead, behind: this.worktree.behind }
        : null,
      sessionId: this.activeSession.sessionId,
      sandbox: this.sandboxLabel,
      goal: this.goal,
      update: this.updateNotice,
    };
  }

  private updateStatusCommand(): void {
    this.statusCommand?.update(
      buildStatusPayload(this.statusFacts(), {
        version: this.options.version ?? 'dev',
        mode: this.activeModeName,
      }),
      this.columns,
    );
  }

  statusLine(width: number, style: Style): StatusLine {
    if (this.statusCommand) {
      const [first = '', ...rest] = this.statusCommandLines;
      return { border: { left: first, right: '' }, below: rest };
    }
    return renderStatusLine(
      this.options.statusLine?.rows ?? DEFAULT_STATUS_ROWS,
      this.statusFacts(),
      width,
      style,
    );
  }

  /**
   * Everything under the transcript: queued messages, the task row, the
   * open card or menu, the prompt box and the status line. `height` is the
   * whole screen, so a card can take what the transcript can spare.
   */
  chrome(width: number, height: number, style: Style): string[] {
    this.columns = width;
    const modal = this.modalCard();
    const prompt = renderPromptBox(
      {
        mode: {
          name: this.activeModeName,
          color: this.options.modes?.find(this.activeModeName)?.colorHex as
            | `#${string}`
            | undefined,
          ...(this.pendingModeName && this.pendingModeName !== this.activeModeName
            ? {
                pending: {
                  name: this.pendingModeName,
                  color: this.options.modes?.find(this.pendingModeName)?.colorHex as
                    | `#${string}`
                    | undefined,
                },
              }
            : {}),
        },
        activity:
          this.running || this.compacting
            ? {
                spinner: this.spinner,
                elapsedMs: this.runStartedAt === null ? 0 : Date.now() - this.runStartedAt,
                label: activityLabel(this),
              }
            : null,
        keys: this.running ? undefined : this.compacting ? 'compacting' : undefined,
        buffer: this.editor.buffer,
        waiting: modal !== null && !(modal instanceof HelpCard),
        editorOpen: this.editorOpen,
        notice: this.notice,
        statusLine: this.statusLine(width, style),
      },
      width,
      style,
    );
    const above: string[] = [];
    if (this.queue.length > 0) {
      const earlier = this.queue.length - MAX_QUEUED_ROWS;
      if (earlier > 0) {
        above.push(`${label('queued', 'dim', style)}${style.fg('dim', `+${earlier} more`)}`);
      }
      for (const [index, message] of this.queue.slice(-MAX_QUEUED_ROWS).entries()) {
        const text = clipToWidth(previewLine(message), Math.max(10, width - BODY_INDENT.length));
        above.push(
          `${index === 0 && earlier <= 0 ? label('queued', 'dim', style) : BODY_INDENT}${style.fg('muted', text)}`,
        );
      }
    }
    if (this.running && this.tasks.length > 0) above.push(renderTaskRow(this.tasks, width, style));
    const room = Math.max(4, height - prompt.length - above.length - MIN_TRANSCRIPT_ROWS);
    let card: string[] = [];
    if (modal) card = modal.render(width, room, style);
    else if (this.helpOpen)
      card = new HelpCard(this.fullscreen, () => {}).render(width, room, style);
    else {
      const items = this.menuItems;
      if (items.length > 0) {
        card = renderMenuCard(
          'commands',
          items.map((item) => ({
            label: `/${item.name}`,
            detail: `${item.kind === 'builtin' ? '' : `${item.kind} · `}${item.description ?? ''}`,
          })),
          Math.min(this.menuHighlight, items.length - 1),
          width,
          room,
          style,
        );
      } else {
        const files = this.fileMenuItems;
        if (files.length > 0) {
          card = renderMenuCard(
            'files',
            files.map((path) => ({ label: path })),
            Math.min(this.fileMenuHighlight, files.length - 1),
            width,
            room,
            style,
          );
        }
      }
    }
    return [...above, ...card, ...prompt];
  }

  /** The updater's state for the status line, and a notice for the transcript. */
  setUpdateStatus(status: string | null, notice?: string): void {
    this.updateNotice = status;
    if (notice) this.scrollback.addInfo(notice);
    this.changed();
  }

  showNotice(text: string, ms = 2_000): void {
    this.notice = text;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = null;
      this.hooks.requestRender();
    }, ms);
    this.noticeTimer.unref?.();
    this.hooks.requestRender();
  }

  // ---------- keys ----------

  handleInput(event: InputEvent): void {
    if (this.disposed) return;
    if (event.type === 'focus' || event.type === 'mouse') return;
    this.handleKey(event);
    this.changed();
  }

  private handleKey(event: InputEvent): void {
    const key = event.type === 'key' ? event : null;
    if (key && (key.name === 'pageup' || key.name === 'pagedown')) {
      const pages = key.name === 'pageup' ? -1 : 1;
      const card = this.modalCard();
      if (card?.scrollPages?.(pages) ?? card?.scroll?.(pages * 5)) return;
      this.scroller?.scrollPages(pages);
      return;
    }
    if (key && key.ctrl && (key.name === 'home' || key.name === 'end') && this.scroller) {
      if (key.name === 'home') this.scroller.toTop();
      else this.scroller.toEnd();
      return;
    }
    const card = this.modalCard();
    if (card) {
      card.handleKey(event);
      return;
    }
    if (this.editorOpen) return;
    if (event.type === 'paste') {
      this.editor.handle(event);
      this.afterEdit();
      return;
    }
    if (!key) return;
    if (key.ctrl && key.name === 'c') {
      if (this.running) {
        this.interruptRun();
        return;
      }
      const now = Date.now();
      if (now - this.lastCtrlC < DOUBLE_CTRL_C_MS) {
        this.cleanupAndExit();
        return;
      }
      this.lastCtrlC = now;
      this.scrollback.addInfo('press Ctrl+C again to exit');
      return;
    }
    const text = this.editor.buffer.text;
    if (this.helpOpen) {
      this.helpOpen = false;
      if (key.name === 'escape' || key.text === '?') return;
    } else if (key.text === '?' && text === '') {
      this.helpOpen = true;
      return;
    }
    const fileContext = this.fileContext;
    const files = this.fileMenuItems;
    if (fileContext && files.length > 0) {
      const selected = Math.min(this.fileMenuHighlight, files.length - 1);
      if (key.name === 'escape') {
        this.fileMenuDismissedAt = fileContext.start;
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        this.fileMenuHighlight =
          key.name === 'up' ? Math.max(0, selected - 1) : Math.min(files.length - 1, selected + 1);
        return;
      }
      if ((key.name === 'tab' && !key.shift) || (key.name === 'enter' && !key.shift && !key.alt)) {
        this.editor.setBuffer(acceptCompletion(this.editor.buffer, fileContext, files[selected]!));
        this.afterEdit();
        return;
      }
    }
    const menu = this.menuItems;
    if (key.name === 'escape' && this.running && menu.length === 0) {
      this.interruptRun();
      return;
    }
    if (key.ctrl && key.name === 'd') {
      this.cleanupAndExit();
      return;
    }
    if (key.ctrl && key.name === 'z') {
      if (process.platform !== 'win32') this.hooks.suspend();
      return;
    }
    if (key.name === 'tab' && key.shift) {
      this.cycleMode();
      return;
    }
    if (menu.length > 0) {
      const highlighted = Math.min(this.menuHighlight, menu.length - 1);
      if (key.name === 'escape') {
        this.menuDismissed = true;
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        this.menuHighlight =
          key.name === 'up'
            ? Math.max(0, highlighted - 1)
            : Math.min(menu.length - 1, highlighted + 1);
        return;
      }
      const selected = menu[highlighted];
      if (key.name === 'tab' && selected) {
        this.editor.setText(`/${selected.name} `);
        this.afterEdit();
        return;
      }
      if (
        key.name === 'enter' &&
        !key.shift &&
        !key.alt &&
        selected &&
        text !== `/${selected.name}`
      ) {
        this.editor.setText(`/${selected.name} `);
        this.afterEdit();
        return;
      }
    }
    if (key.ctrl && !key.alt) {
      if (key.name === 't') return void this.runTranscriptView();
      if (key.name === 'g') return void this.runEditorHandoff();
      if (key.name === 'v') return void this.handlePasteImage();
      if (key.name === 'o') {
        this.expandAll = !this.expandAll;
        this.expandedOverrides.clear();
        return;
      }
      if (key.name === 'b') return;
    }
    if (key.name === 'up' && text === '' && this.queue.length > 0) {
      // The newest queued message comes back for editing before history does.
      this.editor.setText(this.queue.at(-1)!);
      this.queue = this.queue.slice(0, -1);
      this.afterEdit();
      return;
    }
    if (key.name === 'tab' && !key.shift) {
      if (this.running && !text.startsWith('/') && text.trim() !== '') {
        // Enter steers the run in progress; Tab holds the message for the next turn.
        this.queue = [...this.queue, text];
        this.editor.setText('');
        this.afterEdit();
        return;
      }
      const completed = completeSlashPrefix(text, {
        commands: this.options.commands,
        skills: this.options.skills,
        overlay: this.options.sandboxMode === 'overlay',
      });
      if (completed) {
        this.editor.setText(completed);
        this.afterEdit();
      }
      return;
    }
    const outcome = this.editor.handle(key);
    if (outcome.kind === 'submit') void this.handleSubmit(outcome.text);
    if (outcome.kind !== 'unhandled') this.afterEdit();
  }

  /** The prompt text changed: the menus follow it. */
  private afterEdit(): void {
    const text = this.editor.buffer.text;
    this.menuHighlight = 0;
    if (!text.startsWith('/')) this.menuDismissed = false;
    const context = this.fileContext;
    if (!context) this.fileMenuHighlight = 0;
  }

  private cycleMode(): void {
    const all = this.options.modes?.all() ?? [];
    const cycle = this.options.cycleModes ?? all.map((mode) => mode.name);
    const valid = cycle.filter((name) => {
      const mode = all.find((candidate) => candidate.name === name);
      return mode != null && mode.cycle !== false;
    });
    if (valid.length === 0) return;
    const here = this.pendingModeName ?? this.activeModeName;
    const next = valid[(valid.indexOf(here) + 1) % valid.length] ?? valid[0]!;
    this.handleSlash(`/mode ${next}`);
  }

  // ---------- actions ----------

  cleanupAndExit(): void {
    this.hooks.exit();
  }

  interruptRun(): void {
    this.interrupted = true;
    void this.activeSession.client.interrupt(this.activeSession.sessionId);
    this.scrollback.addInfo('interrupt sent');
  }

  resetTranscript(): void {
    this.scrollback.clear();
    this.showBanner = false;
    this.expandedOverrides.clear();
    this.hooks.transcriptReset();
  }

  private async drainQueue(): Promise<void> {
    const items = this.queue;
    this.queue = [];
    const regulars: string[] = [];
    for (const item of items) {
      if (item.startsWith('!')) {
        if (regulars.length > 0) {
          await this.sendUserMessage(regulars.join('\n\n'));
          regulars.length = 0;
        }
        await this.handleBang(item.slice(1).trim());
      } else regulars.push(item);
    }
    if (regulars.length > 0) await this.sendUserMessage(regulars.join('\n\n'));
  }

  async handleSubmit(text: string): Promise<void> {
    this.scroller?.toEnd();
    const expanded = this.pastes.expand(text);
    this.pastes.clear();
    if (expanded.startsWith('!')) {
      const command = expanded.slice(1).trim();
      if (command.length === 0) return;
      if (this.busy) {
        this.queue = [...this.queue, expanded];
        this.changed();
        return;
      }
      await this.handleBang(command);
      return;
    }
    if (expanded.startsWith('/')) {
      this.handleSlash(expanded.trim());
      return;
    }
    if (this.running) {
      void this.injectMidRun(expanded);
      return;
    }
    if (this.busy) {
      this.queue = [...this.queue, expanded];
      this.changed();
      return;
    }
    await this.sendUserMessage(expanded);
  }

  private async handleBang(command: string): Promise<void> {
    this.scrollback.addInfo(`running: ${previewLine(command)}`);
    this.bangRunning = true;
    this.changed();
    try {
      const result = await runBangCommand(command, this.options.cwd);
      const lines: string[] = [];
      if (result.stdout) lines.push(result.stdout);
      if (result.stderr) lines.push(result.stderr);
      if (!result.stdout && !result.stderr) lines.push('(no output)');
      const summary = `!${command} (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}${result.killedByBuffer ? ', truncated' : ''})`;
      await this.activeSession.client.appendMessage(
        this.activeSession.sessionId,
        [summary, ...lines].join('\n'),
      );
    } catch (err) {
      this.scrollback.addError(`! failed: ${(err as Error).message}`);
    } finally {
      this.bangRunning = false;
      this.changed();
    }
  }

  private async handlePasteImage(): Promise<void> {
    const image = await readClipboardImage();
    if (!image) {
      this.scrollback.addInfo('clipboard: no image found');
      return;
    }
    try {
      const path = await saveImageToSession(this.activeSession.sessionId, image);
      this.pendingImages = [...this.pendingImages, path];
      this.editor.insert(` [Image #${this.pendingImages.length}]`);
      this.changed();
    } catch (err) {
      this.scrollback.addError(`clipboard paste failed: ${(err as Error).message}`);
    }
  }

  private async injectMidRun(text: string): Promise<void> {
    try {
      await this.activeSession.client.appendMessage(this.activeSession.sessionId, text);
      this.scrollback.addInfo(`injected: ${previewLine(text)}`);
    } catch (err) {
      this.scrollback.addError(`inject failed: ${(err as Error).message}`);
    }
  }

  async sendUserMessage(text: string): Promise<void> {
    const session = this.activeSession;
    const hydration = this.hydration;
    const tokens = parseAttachTokens(text, this.options.cwd);
    const imagePaths = [...this.pendingImages];
    for (const token of tokens) {
      if (isImageFile(token.absolute)) {
        imagePaths.push(token.absolute);
        continue;
      }
      try {
        await session.client.addPath(session.sessionId, token.kind, token.absolute);
      } catch (err) {
        this.scrollback.addError(`attach ${token.raw}: ${(err as Error).message}`);
        continue;
      }
      const info = await readForAttach(token.absolute);
      if (info.kind === 'missing' || info.kind === 'error') {
        this.scrollback.addError(`attach ${token.raw}: ${info.body}`);
        continue;
      }
      try {
        await session.client.appendMessage(
          session.sessionId,
          `[auto-attached ${token.kind === 'read' ? '@' : '#'}${token.raw}]\n${info.body}`,
        );
      } catch (err) {
        this.scrollback.addError(`attach ${token.raw}: ${(err as Error).message}`);
      }
    }
    this.pendingImages = [];
    const cleanText = text.replace(/\[Image #\d+\]/g, '').trim();
    this.running = true;
    this.streaming = false;
    this.changed();
    try {
      for await (const _event of session.client.send(session.sessionId, cleanText, {
        images: imagePaths.length > 0 ? imagePaths : undefined,
      })) {
        // Events arrive through the subscription; send() drives the request.
      }
    } catch (err) {
      if (isActiveRunConflict(err)) {
        try {
          await session.client.appendMessage(
            session.sessionId,
            cleanText,
            imagePaths.length > 0 ? imagePaths : undefined,
          );
          const snapshot = await session.client.getSession(session.sessionId);
          if (this.hydration === hydration) this.running = sessionHasActiveRun(snapshot.status);
          this.scrollback.addInfo(`injected: ${previewLine(cleanText)}`);
        } catch (appendError) {
          this.scrollback.addError(`inject failed: ${(appendError as Error).message}`);
        }
        this.changed();
        return;
      }
      this.scrollback.addError(`send failed: ${(err as Error).message}`);
    }
    this.changed();
  }

  handleSlash(raw: string): void {
    dispatchSlash(raw, {
      props: this.options,
      scrollback: this.scrollback,
      themeCtx: { reload: () => this.hooks.reloadTheme() },
      activeSession: this.activeSession,
      setActiveSession: (next) => {
        const value = typeof next === 'function' ? next(this.activeSession) : next;
        if (value === this.activeSession) return;
        this.activeSession = value;
        this.switchedSession();
      },
      running: this.running,
      busy: this.busy,
      setRunning: this.setter('running'),
      setStreaming: this.setter('streaming'),
      setCompacting: this.setter('compacting'),
      setQueue: this.setter('queue'),
      activeModeName: this.activeModeName,
      pendingModeName: this.pendingModeName,
      setPendingModeName: this.setter('pendingModeName'),
      currentModelRef: this.currentModelRef,
      goal: this.goal,
      overlayMode: this.options.sandboxMode === 'overlay',
      setOverlayPicker: this.setter('overlayPicker'),
      setSessionPicker: this.setter('sessionPicker'),
      setRewindPicker: this.setter('rewindPicker'),
      resetTranscript: () => this.resetTranscript(),
      openMemoryIndex: () => this.openMemoryIndex(),
      sendUserMessage: (message) => this.sendUserMessage(message),
      injectMidRun: (message) => this.injectMidRun(message),
      cleanupAndExit: async () => this.cleanupAndExit(),
    });
  }

  private async withEditorOpen(operation: () => Promise<void>): Promise<void> {
    if (this.editorOpen) return;
    this.editorOpen = true;
    this.changed();
    try {
      await operation();
    } finally {
      this.editorOpen = false;
      this.changed();
    }
  }

  async runEditorHandoff(): Promise<void> {
    await this.withEditorOpen(async () => {
      const open =
        this.options.openInEditor ??
        ((args: { initialText: string }) =>
          openInEditor({
            initialText: args.initialText,
            mouseActive: false,
            stdout: process.stdout,
            stdin: process.stdin,
          }));
      const result: OpenInEditorResult = await this.hooks.handoff(() =>
        open({ initialText: this.editor.buffer.text }),
      );
      if (result.ok) this.editor.setText(result.text);
      else this.scrollback.addInfo(`editor: ${result.reason}`);
    });
  }

  async runTranscriptView(): Promise<void> {
    await this.withEditorOpen(async () => {
      const open =
        this.options.openInPager ??
        ((args: { text: string }) =>
          openInPager({ text: args.text, stdout: process.stdout, stdin: process.stdin }));
      const text = formatTranscript(this.scrollback.all(), {
        color: this.options.openInPager === undefined,
      });
      const result = await this.hooks.handoff(() => open({ text }));
      if (!result.ok) this.scrollback.addInfo(`transcript: ${result.reason}`);
    });
  }

  private async openMemoryIndex(): Promise<void> {
    const path = this.options.memoryIndexPath;
    if (!path) {
      this.scrollback.addInfo(
        'project memory is not available in this session (memory.enabled is false, or the session is attached).',
      );
      return;
    }
    await this.withEditorOpen(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, '# Memory index\n\n', { flag: 'wx' }).catch(() => {});
        const open =
          this.options.openFileInEditor ??
          ((args: { path: string }) =>
            openFileInEditor({ path: args.path, stdout: process.stdout, stdin: process.stdin }));
        const result = await this.hooks.handoff(() => open({ path }));
        this.scrollback.addInfo(
          result.ok
            ? `memory index saved: ${path} · /reload brings it into this session`
            : `memory: ${result.reason}`,
        );
      } catch (err) {
        this.scrollback.addError(`memory: ${(err as Error).message}`);
      }
    });
  }

  answerQuestion(resolution: QuestionResolution): void {
    const question = this.question;
    if (!question) return;
    const { requestId } = question;
    this.questionQueue = this.questionQueue.filter((queued) => queued.requestId !== requestId);
    this.changed();
    void this.activeSession.client
      .answerQuestion(this.activeSession.sessionId, requestId, resolution)
      .catch((err: unknown) => {
        if (!(err instanceof ChimeraHttpError && err.status === 409)) {
          this.scrollback.addError(`answer failed: ${(err as Error).message}`);
        }
      });
  }

  onResolve(action: PermissionDecisionAction): void {
    const item = this.pending;
    if (!item) return;
    if (
      action.decision !== 'deny' &&
      !item.subagent &&
      requiresSudoAuthentication(item.policyAnalysis)
    ) {
      void this.beginSudoAuthentication(item, action);
      return;
    }
    void this.resolvePermission(item, action);
  }

  private async beginSudoAuthentication(
    item: PendingPermission,
    action: PermissionDecisionAction,
  ): Promise<void> {
    const { checkSudo, authenticateSudo } = this.options;
    if (!checkSudo || !authenticateSudo) {
      this.scrollback.addError('sudo authentication is unavailable in this client.');
      return;
    }
    const controller = new AbortController();
    this.sudoController?.abort();
    this.sudoController = controller;
    this.sudoAuthentication = { item, action, status: 'checking' };
    this.changed();
    let result: Awaited<ReturnType<typeof checkSudo>>;
    try {
      result = await checkSudo({
        requestId: item.requestId,
        command: item.command,
        signal: controller.signal,
      });
    } catch (err) {
      if (this.sudoController !== controller || controller.signal.aborted) return;
      this.sudoController = null;
      this.sudoAuthentication = null;
      this.scrollback.addError(`sudo authentication failed: ${(err as Error).message}`);
      this.changed();
      return;
    }
    if (this.sudoController !== controller) return;
    if (result.status === 'validated') {
      this.sudoController = null;
      this.sudoAuthentication = null;
      await this.resolvePermission(item, action);
    } else if (result.status === 'password_required') {
      this.sudoAuthentication = { item, action, status: 'password' };
    } else {
      this.sudoController = null;
      this.sudoAuthentication = null;
      this.scrollback.addError(
        ('message' in result ? result.message : undefined) ?? 'sudo authentication is unavailable.',
      );
    }
    this.changed();
  }

  private async submitSudoPassword(password: Uint8Array): Promise<void> {
    const authentication = this.sudoAuthentication;
    const authenticate = this.options.authenticateSudo;
    if (!authentication || !authenticate) {
      password.fill(0);
      return;
    }
    this.sudoAuthentication = { ...authentication, status: 'validating', error: undefined };
    this.changed();
    const controller = this.sudoController;
    let result: Awaited<ReturnType<typeof authenticate>>;
    try {
      result = await authenticate({
        requestId: authentication.item.requestId,
        command: authentication.item.command,
        password,
        signal: controller?.signal,
      });
    } catch (err) {
      password.fill(0);
      if (this.sudoController !== controller || controller?.signal.aborted) return;
      this.sudoAuthentication = {
        ...authentication,
        status: 'password',
        error: (err as Error).message,
      };
      this.changed();
      return;
    }
    password.fill(0);
    if (this.sudoController !== controller) return;
    if (result.status === 'validated') {
      this.sudoController = null;
      this.sudoAuthentication = null;
      await this.resolvePermission(authentication.item, authentication.action);
    } else if (result.status === 'failed') {
      this.sudoAuthentication = { ...authentication, status: 'password', error: result.message };
    } else {
      this.sudoController = null;
      this.sudoAuthentication = null;
      this.scrollback.addError(result.message ?? 'sudo authentication was cancelled.');
    }
    this.changed();
  }

  private cancelSudoAuthentication(): void {
    this.sudoController?.abort();
    this.sudoController = null;
    this.sudoAuthentication = null;
    this.changed();
  }

  private async resolvePermission(
    item: PendingPermission,
    action: PermissionDecisionAction,
  ): Promise<void> {
    const hydration = this.hydration;
    // Answered: the card goes at once, while the answer travels.
    this.permissionQueue = this.permissionQueue.filter(
      (queued) => queued.requestId !== item.requestId,
    );
    hydration.resolvedPermissionIds.add(item.requestId);
    this.changed();
    const client = item.subagent
      ? new ChimeraClient({ baseUrl: item.subagent.url })
      : this.activeSession.client;
    const sessionId = item.subagent ? item.subagent.sessionId : this.activeSession.sessionId;
    try {
      await client.resolvePermissionAction(sessionId, item.requestId, action);
    } catch (err) {
      this.scrollback.addError(`permission: ${(err as Error).message}`);
    }
  }

  private applyOverlaySelection(selection: { paths: string[] } | null): void {
    const offered = this.overlayPicker ?? [];
    this.overlayPicker = null;
    this.changed();
    if (!selection) {
      this.scrollback.addInfo('apply cancelled');
      return;
    }
    void (async () => {
      try {
        await this.options.overlay!.apply(selection.paths);
        this.scrollback.addInfo(
          `applied ${selection.paths.length}/${offered.length} overlay paths`,
        );
      } catch (err) {
        this.scrollback.addError(`apply: ${(err as Error).message}`);
      }
    })();
  }

  private cancelSessionPicker(): void {
    this.sessionPicker = null;
    this.scrollback.addInfo('/sessions cancelled');
    this.changed();
  }

  private selectSession(selectedId: SessionId): void {
    this.sessionPicker = null;
    this.changed();
    if (selectedId === this.activeSession.sessionId) {
      this.scrollback.addInfo(`already on session ${selectedId.slice(-8)}`);
      return;
    }
    void (async () => {
      try {
        await this.options.client.resumeSession(selectedId, this.activeSession.sessionId);
        this.resetTranscript();
        this.activeSession = {
          client: this.options.client,
          sessionId: selectedId,
          label: 'session',
        };
        this.queue = [];
        this.streaming = false;
        this.switchedSession();
        this.scrollback.addInfo(`switched to session ${selectedId.slice(-8)}`);
      } catch (err) {
        this.scrollback.addError(`/sessions: ${(err as Error).message}`);
      }
    })();
  }

  private cancelRewind(): void {
    this.rewindPicker = null;
    this.scrollback.addInfo('/rewind cancelled');
    this.changed();
  }

  private rewindTo(checkpoint: Checkpoint): void {
    this.rewindPicker = null;
    this.running = false;
    this.queue = [];
    this.streaming = false;
    this.changed();
    void (async () => {
      try {
        const session = this.activeSession;
        const result = await session.client.rewindSession(session.sessionId, checkpoint.index);
        this.resetTranscript();
        const info = await session.client.getSession(session.sessionId);
        if (Array.isArray(info.messages) && info.messages.length > 0)
          this.scrollback.rehydrateFromSession(info);
        this.editor.setText(checkpoint.userMessage);
        this.scrollback.addInfo(
          result.workspaceRestored
            ? `rewound to checkpoint ${checkpoint.index} (working tree restored)`
            : `rewound to checkpoint ${checkpoint.index} (conversation only; working tree unchanged)`,
        );
      } catch (err) {
        this.scrollback.addError(`/rewind: ${(err as Error).message}`);
      }
      this.changed();
    })();
  }

  private forkFrom(checkpoint: Checkpoint): void {
    this.rewindPicker = null;
    this.changed();
    void (async () => {
      try {
        const { sessionId: childId } = await this.options.client.forkSession(
          this.activeSession.sessionId,
          undefined,
          checkpoint.index,
          this.activeSession.sessionId,
        );
        this.resetTranscript();
        this.activeSession = { client: this.options.client, sessionId: childId, label: 'forked' };
        this.queue = [];
        this.streaming = false;
        this.switchedSession();
        const info = await this.activeSession.client.getSession(childId);
        if (Array.isArray(info.messages) && info.messages.length > 0)
          this.scrollback.rehydrateFromSession(info);
        this.editor.setText(checkpoint.userMessage);
        this.scrollback.addInfo(
          `forked from checkpoint ${checkpoint.index} into session ${childId.slice(-8)}`,
        );
      } catch (err) {
        this.scrollback.addError(`/rewind fork: ${(err as Error).message}`);
      }
      this.changed();
    })();
  }
}

export type { KeyEvent };

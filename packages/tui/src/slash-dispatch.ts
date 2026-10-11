import { resolve as resolvePath } from 'node:path';
import { ChimeraClient } from '@chimera/client';
import type { Checkpoint, SessionId, SessionInfo } from '@chimera/core';
import type { Dispatch, SetStateAction } from 'react';
import type { AppProps } from './App';
import type { OverlayDiffEntry } from './OverlayPicker';
import { buildSessionTreeRows, formatRelativeTime } from './SessionPicker';
import type { Scrollback } from './scrollback';
import { BUILTIN_COMMANDS, findClosestCommand } from './slash-commands';
import { applyThemeByName, listThemes } from './theme/loader';
import type { useThemeContext } from './theme/ThemeProvider';

export interface ActiveSession {
  client: ChimeraClient;
  sessionId: SessionId;
  label: string;
}

/** What a slash command may read and change in the App. */
export interface SlashContext {
  props: AppProps;
  scrollback: Scrollback;
  themeCtx: ReturnType<typeof useThemeContext>;
  activeSession: ActiveSession;
  setActiveSession: Dispatch<SetStateAction<ActiveSession>>;
  running: boolean;
  /** A run, a compaction or a `!` command is in flight. */
  busy: boolean;
  setRunning: Dispatch<SetStateAction<boolean>>;
  setStreaming: Dispatch<SetStateAction<boolean>>;
  setCompacting: Dispatch<SetStateAction<boolean>>;
  setQueue: Dispatch<SetStateAction<string[]>>;
  activeModeName: string;
  pendingModeName: string | null;
  setPendingModeName: Dispatch<SetStateAction<string | null>>;
  currentModelRef: string;
  overlayMode: boolean;
  setOverlayPicker: Dispatch<SetStateAction<OverlayDiffEntry[] | null>>;
  setSessionPicker: Dispatch<SetStateAction<SessionInfo[] | null>>;
  setRewindPicker: Dispatch<SetStateAction<Checkpoint[] | null>>;
  /** Throw the transcript away, on screen and in the store. */
  resetTranscript: () => void;
  sendUserMessage: (text: string) => Promise<void>;
  injectMidRun: (text: string) => Promise<void>;
  cleanupAndExit: () => Promise<void>;
}

function expandSkillInvocation(name: string, path: string, args: string): string {
  const trimmed = args.trim();
  const head = `Use the "${name}" skill from ${path}.`;
  return trimmed.length > 0 ? `${head}\n\n${trimmed}` : head;
}

/** Run one `/command` line typed at the prompt. */
export function dispatchSlash(raw: string, context: SlashContext): void {
  const {
    props,
    scrollback,
    themeCtx,
    activeSession,
    setActiveSession,
    running,
    busy,
    setRunning,
    setStreaming,
    setCompacting,
    setQueue,
    activeModeName,
    pendingModeName,
    setPendingModeName,
    currentModelRef,
    overlayMode,
    setOverlayPicker,
    setSessionPicker,
    setRewindPicker,
    resetTranscript,
    sendUserMessage,
    injectMidRun,
    cleanupAndExit,
  } = context;
  const [name, ...rest] = raw.split(/\s+/);
  const arg = rest.join(' ');
  switch (name) {
    case '/help': {
      const builtinLines = BUILTIN_COMMANDS.map((c) => `${c.name} — ${c.description}`);
      const userLines = (props.commands?.list() ?? []).map(
        (c) => `/${c.name} — ${c.description ?? '(user command)'}`,
      );
      const all =
        userLines.length > 0 ? [...builtinLines, '', 'User commands:', ...userLines] : builtinLines;
      scrollback.addInfo(all.join('\n'));
      return;
    }
    case '/clear':
      resetTranscript();
      return;
    case '/exit':
      void cleanupAndExit();
      return;
    case '/model': {
      if (arg) {
        const target = arg === 'default' || arg === 'reset' ? null : arg;
        void (async () => {
          try {
            await activeSession.client.setModel(activeSession.sessionId, target);
            scrollback.addInfo(target ? `model set to ${target}` : 'model override cleared');
          } catch (error) {
            scrollback.addError(`/model: ${(error as Error).message}`);
          }
        })();
      } else {
        scrollback.addInfo(`current model: ${currentModelRef}`);
      }
      return;
    }
    case '/add-read-path':
    case '/add-write-path': {
      const kind = name === '/add-read-path' ? 'read' : 'write';
      if (!arg) {
        scrollback.addError(`usage: ${name} <path>`);
        return;
      }
      void (async () => {
        try {
          await activeSession.client.addPath(activeSession.sessionId, kind, arg);
          scrollback.addInfo(`${name}: granted ${kind} access to ${arg}`);
        } catch (err) {
          scrollback.addError(`${name}: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/rules': {
      void (async () => {
        try {
          if (arg.startsWith('rm ')) {
            const idx = Number.parseInt(arg.slice(3).trim(), 10);
            if (!Number.isInteger(idx)) {
              scrollback.addError('usage: /rules rm <index>');
            } else {
              await activeSession.client.removeRule(activeSession.sessionId, idx);
              scrollback.addInfo(`removed rule ${idx}`);
            }
          } else {
            const rules = await activeSession.client.listRules(activeSession.sessionId);
            if (rules.length === 0) scrollback.addInfo('no rules');
            else {
              rules.forEach((r, i) => {
                scrollback.addInfo(`[${i}] ${r.decision} ${r.tool} ${r.patternKind} ${r.pattern}`);
              });
            }
          }
        } catch (err) {
          scrollback.addError(`/rules: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/new': {
      void (async () => {
        try {
          const { sessionId: newId } = await props.client.createSession({
            cwd: props.cwd,
            model: props.model,
            sandboxMode: props.sandboxMode ?? 'off',
          });
          resetTranscript();
          setPendingModeName(null); // Reset pending mode on new session
          setActiveSession({
            client: props.client,
            sessionId: newId,
            label: 'session',
          });
          setRunning(false);
          setQueue([]);
          setStreaming(false);
          scrollback.addInfo(`new session ${newId.slice(-8)}`);
        } catch (err) {
          scrollback.addError(`/new: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/sessions': {
      void (async () => {
        try {
          const allSessions = await props.client.listSessions();
          const sub = rest.join(' ').trim();
          // /sessions all → bypass cwd-scoping for the picker
          const showAll = sub === 'all';
          const targetCwd = resolvePath(props.cwd);
          const scoped = showAll
            ? allSessions
            : allSessions.filter((s) => resolvePath(s.cwd) === targetCwd);
          const scopeLabel = showAll ? '(all directories)' : `in ${props.cwd}`;
          if (sub === 'tree') {
            if (scoped.length === 0) {
              scrollback.addInfo(`no persisted sessions ${scopeLabel}`);
            } else {
              const rows = buildSessionTreeRows(scoped);
              const lines = rows.map((r) => {
                const truncId = r.info.id.slice(-8);
                const childMark = r.info.children.length > 0 ? ` (${r.info.children.length})` : '';
                const marker = r.info.id === activeSession.sessionId ? '  ←' : '';
                return `${r.prefix}${truncId}${childMark}  ${r.info.messageCount} msg${marker}`;
              });
              scrollback.addInfo(`session tree ${scopeLabel}:\n${lines.join('\n')}`);
            }
            return;
          }
          if (sub.length > 0 && sub !== 'all') {
            // /sessions <id> — always look up against the full set
            const target = allSessions.find((s) => s.id === sub || s.id.endsWith(sub));
            if (!target) {
              scrollback.addError(`/sessions: no session matching ${sub}`);
              return;
            }
            const ancestry: string[] = [];
            {
              const renderedAt = Date.now();
              let cur: SessionInfo | undefined = target;
              while (cur) {
                ancestry.unshift(
                  `${cur.id.slice(-8)} (${formatRelativeTime(renderedAt, cur.createdAt)})`,
                );
                if (!cur.parentId) break;
                cur = allSessions.find((s) => s.id === cur!.parentId);
              }
            }
            const lines = [
              `id:        ${target.id}`,
              `cwd:       ${target.cwd}`,
              `model:     ${target.model.providerId}/${target.model.modelId}`,
              `parent:    ${target.parentId ?? '(root)'}`,
              `children:  ${target.children.length}`,
              `messages:  ${target.messageCount}`,
              `ancestry:  ${ancestry.join(' → ')}`,
            ];
            scrollback.addInfo(lines.join('\n'));
            return;
          }
          // No sub-arg (or `all`): open interactive picker
          if (scoped.length === 0) {
            scrollback.addInfo(
              `no persisted sessions ${scopeLabel}` +
                (showAll ? '' : ' — use `/sessions all` to see every session'),
            );
            return;
          }
          setSessionPicker(scoped);
        } catch (err) {
          scrollback.addError(`/sessions: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/fork': {
      const purpose = rest.join(' ').trim();
      void (async () => {
        try {
          const { sessionId: childId, parentId } = await props.client.forkSession(
            activeSession.sessionId,
            purpose.length > 0 ? purpose : undefined,
          );
          resetTranscript();
          setActiveSession({
            client: props.client,
            sessionId: childId,
            label: 'forked',
          });
          setRunning(false);
          setQueue([]);
          setStreaming(false);
          scrollback.addInfo(
            `forked session ${childId.slice(-8)} from ${parentId.slice(-8)}${
              purpose.length > 0 ? ` (${purpose})` : ''
            }`,
          );
        } catch (err) {
          scrollback.addError(`/fork: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/rewind': {
      if (busy) {
        setQueue((q) => [...q, raw]);
        return;
      }
      void (async () => {
        try {
          const checkpoints = await activeSession.client.listCheckpoints(activeSession.sessionId);
          if (checkpoints.length <= 1) {
            scrollback.addInfo('no checkpoints to rewind to');
            return;
          }
          setRewindPicker(checkpoints);
        } catch (err) {
          scrollback.addError(`/rewind: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/subagents': {
      void (async () => {
        try {
          const list = await activeSession.client.listSubagents(activeSession.sessionId);
          if (list.length === 0) {
            scrollback.addInfo('no active subagents');
          } else {
            const lines = list.map(
              (s) => `${s.subagentId}  ${s.purpose}  ${s.status}  ${s.url || '(in-process)'}`,
            );
            const hint =
              '\n\nTo inspect: copy a subagentId, then run `chimera attach <id>` in another terminal,\n' +
              'or use /attach <id> here to drill the TUI into the child.';
            scrollback.addInfo(`subagents:\n${lines.join('\n')}${hint}`);
          }
        } catch (err) {
          scrollback.addError(`/subagents: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/attach': {
      const target = arg.trim();
      if (!target) {
        scrollback.addInfo('usage: /attach <subagentId>');
        return;
      }
      void (async () => {
        try {
          const list = await activeSession.client.listSubagents(activeSession.sessionId);
          const match = list.find((s) => s.subagentId === target || s.subagentId.endsWith(target));
          if (!match) {
            scrollback.addError(`/attach: no subagent matching "${target}"`);
            return;
          }
          if (!match.url) {
            scrollback.addError(
              `/attach: subagent ${match.subagentId} is in-process and not attachable`,
            );
            return;
          }
          const childClient = new ChimeraClient({ baseUrl: match.url });
          scrollback.addInfo(
            `attaching to subagent ${match.subagentId} (${match.purpose}) at ${match.url}`,
          );
          setPendingModeName(null); // Reset pending mode on attach
          setActiveSession({
            client: childClient,
            sessionId: match.sessionId,
            label: `subagent ${match.subagentId.slice(-8)}`,
          });
          // Drop parent-session UI state — its run/queue belong to the
          // parent's stream, which we are no longer subscribed to.
          setRunning(false);
          setQueue([]);
          setStreaming(false);
        } catch (err) {
          scrollback.addError(`/attach: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/detach': {
      if (activeSession.client === props.client && activeSession.sessionId === props.sessionId) {
        scrollback.addInfo('already attached to the parent session');
        return;
      }
      scrollback.addInfo('detaching back to parent session');
      setActiveSession({
        client: props.client,
        sessionId: props.sessionId,
        label: 'parent',
      });
      setRunning(false);
      setQueue([]);
      setStreaming(false);
      return;
    }
    case '/context': {
      void (async () => {
        try {
          const breakdown = await activeSession.client.getContextBreakdown(activeSession.sessionId);
          const fmt = (n: number) => n.toLocaleString('en-US');
          const pct = (n: number) => `${Math.round((n / breakdown.contextWindow) * 100)}%`;
          const lines = [
            `context window: ${fmt(breakdown.contextWindow)} tokens`,
            breakdown.lastPromptTokens !== null
              ? `last prompt (actual): ${fmt(breakdown.lastPromptTokens)} (${pct(breakdown.lastPromptTokens)})`
              : 'last prompt (actual): n/a (no step yet)',
            `estimated now: ${fmt(breakdown.estimatedTotalTokens)} (${pct(breakdown.estimatedTotalTokens)})`,
            breakdown.triggerTokens !== null
              ? `auto-compact trigger: ${fmt(breakdown.triggerTokens)} (${pct(breakdown.triggerTokens)})`
              : 'auto-compact: disabled',
            `  system prompt: ~${fmt(breakdown.systemPromptTokens)}`,
            ...(breakdown.summaryTokens > 0
              ? [`  compaction summary: ~${fmt(breakdown.summaryTokens)}`]
              : []),
            `  user messages: ~${fmt(breakdown.userTokens)}`,
            `  assistant messages: ~${fmt(breakdown.assistantTokens)}`,
            `  tool results: ~${fmt(breakdown.toolTokens)} (${breakdown.archivedStubCount} archived stub${breakdown.archivedStubCount === 1 ? '' : 's'})`,
            `  messages: ${breakdown.messageCount}`,
          ];
          for (const line of lines) scrollback.addInfo(line);
        } catch (err) {
          scrollback.addError(`/context: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/compact': {
      if (busy) {
        setQueue((q) => [...q, raw]);
        return;
      }
      setCompacting(true);
      scrollback.addInfo('compacting...');
      void (async () => {
        try {
          await activeSession.client.compact(activeSession.sessionId);
        } catch (err) {
          setCompacting(false);
          scrollback.addError(`/compact: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/reload': {
      const reg = props.commands;
      const reloadFn = reg?.reload;
      if (!reloadFn) {
        scrollback.addInfo('commands: reload not supported in this session.');
        return;
      }
      void (async () => {
        try {
          // Reload user commands.
          await reloadFn.call(reg);
          // Reload AGENTS.md/AGENTS.local.md/CLAUDE.md if the hook is provided.
          if (props.reloadSystemPrompt) {
            const newPrompt = await props.reloadSystemPrompt({ cwd: props.cwd });
            await props.client.reloadSession(props.sessionId, newPrompt);
            scrollback.addInfo('system prompt reloaded.');
          } else {
            scrollback.addInfo('commands reloaded.');
          }
        } catch (err) {
          scrollback.addError(`reload failed: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/mode': {
      const target = arg.trim();
      if (!target) {
        const list = props.modes?.all() ?? [];
        if (list.length === 0) {
          scrollback.addInfo('no modes available (mode discovery is disabled).');
        } else {
          const lines = list.map((mode) => {
            const marker = mode.name === activeModeName ? '* ' : '  ';
            const tail = mode.name === activeModeName ? ' (active)' : '';
            return `${marker}${mode.name} — ${mode.description}${tail}`;
          });
          scrollback.addInfo(`Modes:\n${lines.join('\n')}`);
        }
        return;
      }
      const next = props.modes?.find(target);
      if (!next) {
        scrollback.addError(`unknown mode "${target}"`);
        return;
      }
      const effectiveCurrent = pendingModeName ?? activeModeName;
      if (next.name === effectiveCurrent) return;
      setPendingModeName(next.name);
      void (async () => {
        try {
          await activeSession.client.setMode(activeSession.sessionId, next.name);
          if (running) {
            // Mid-run switch: interrupt so the new mode applies as soon as
            // the run terminates rather than after the model finishes its
            // multi-step plan. Any text already streaming is past saving;
            // anything not yet sent will be in the new mode.
            await activeSession.client.interrupt(activeSession.sessionId);
          }
        } catch (err) {
          setPendingModeName(null);
          scrollback.addError(`mode switch failed: ${(err as Error).message}`);
        }
      })();
      return;
    }
    case '/theme': {
      const target = arg.trim();
      if (!target) {
        try {
          const themes = listThemes();
          if (themes.length === 0) {
            scrollback.addInfo('no themes available');
          } else {
            const lines = themes.map((t) => {
              const marker = t.active ? '* ' : '  ';
              const tag = t.source === 'user' ? ' (user)' : '';
              return `${marker}${t.name}${tag}`;
            });
            const hint = '\n\nUse /theme <name> to apply.';
            scrollback.addInfo(`themes:\n${lines.join('\n')}${hint}`);
          }
        } catch (err) {
          scrollback.addError(`/theme: ${(err as Error).message}`);
        }
        return;
      }
      try {
        const applyResult = applyThemeByName(target);
        themeCtx.reload();
        scrollback.addInfo(
          `theme: applied '${target}' (${applyResult.origin === 'user' ? 'user' : 'builtin'}).`,
        );
      } catch (err) {
        scrollback.addError(`/theme: ${(err as Error).message}`);
      }
      return;
    }
    case '/overlay':
    case '/apply':
    case '/discard': {
      if (!overlayMode || !props.overlay) {
        scrollback.addError(`${name} requires --sandbox-mode overlay`);
        return;
      }
      if (name === '/overlay') {
        void (async () => {
          try {
            const diff = await props.overlay!.diff();
            const total = diff.added.length + diff.modified.length + diff.deleted.length;
            if (total === 0) {
              scrollback.addInfo('overlay: no pending changes');
            } else {
              const lines: string[] = [];
              for (const p of diff.added) lines.push(`  + ${p}`);
              for (const p of diff.modified) lines.push(`  ~ ${p}`);
              for (const p of diff.deleted) lines.push(`  - ${p}`);
              scrollback.addInfo(`overlay diff (${total}):\n${lines.join('\n')}`);
            }
          } catch (err) {
            scrollback.addError(`overlay: ${(err as Error).message}`);
          }
        })();
        return;
      }
      if (name === '/apply') {
        void (async () => {
          try {
            const diff = await props.overlay!.diff();
            const entries: OverlayDiffEntry[] = [
              ...diff.added.map<OverlayDiffEntry>((path) => ({ kind: 'added', path })),
              ...diff.modified.map<OverlayDiffEntry>((path) => ({
                kind: 'modified',
                path,
              })),
              ...diff.deleted.map<OverlayDiffEntry>((path) => ({
                kind: 'deleted',
                path,
              })),
            ];
            if (entries.length === 0) {
              scrollback.addInfo('overlay: no pending changes');
              return;
            }
            setOverlayPicker(entries);
          } catch (err) {
            scrollback.addError(`overlay: ${(err as Error).message}`);
          }
        })();
        return;
      }
      // /discard
      void (async () => {
        try {
          await props.overlay!.discard();
          scrollback.addInfo('overlay discarded');
        } catch (err) {
          scrollback.addError(`discard: ${(err as Error).message}`);
        }
      })();
      return;
    }
    default: {
      const templateName = name!.startsWith('/') ? name!.slice(1) : name!;
      const template = props.commands?.find(templateName);
      if (template) {
        let expanded: string;
        try {
          expanded = props.commands!.expand(templateName, arg, { cwd: props.cwd });
        } catch (err) {
          scrollback.addError(`/${templateName}: ${(err as Error).message}`);
          return;
        }
        scrollback.addUserMessage(raw);
        scrollback.suppressUserMessageMatching(expanded);
        if (running) {
          void injectMidRun(expanded);
          return;
        }
        void sendUserMessage(expanded);
        return;
      }
      const skill = props.skills?.find(templateName);
      if (skill) {
        const body = expandSkillInvocation(skill.name, skill.path, arg);
        scrollback.addUserMessage(raw);
        scrollback.suppressUserMessageMatching(body);
        if (running) {
          void injectMidRun(body);
          return;
        }
        void sendUserMessage(body);
        return;
      }
      const suggestion = findClosestCommand(name!, props.commands, props.skills);
      scrollback.addError(
        suggestion
          ? `unknown command: ${name} — did you mean ${suggestion}?`
          : `unknown command: ${name}`,
      );
    }
  }
}

import type { AgentEvent, PermissionDecisionAction } from '@chimera/core';
import { wrapText } from '../ledger/text';
import type { PendingPermission } from '../permission-queue';
import type { InputEvent } from '../terminal/keys';
import type { Style } from '../theme/style';
import {
  type Card,
  type CardScroll,
  cardInnerWidth,
  choiceRow,
  factRow,
  inputRow,
  oneLine,
  renderCard,
  scrollCard,
} from './card';

type PolicyAnalysis = Extract<AgentEvent, { type: 'permission_request' }>['policyAnalysis'];

type Mode =
  | { kind: 'choose' }
  | { kind: 'feedback'; text: string }
  | { kind: 'pattern' | 'prefix'; text: string }
  | { kind: 'scope'; pattern: string; patternKind: 'exact' | 'glob' | 'prefix' };

interface Choice {
  key: string;
  label: string;
  tone: 'allow' | 'deny';
  run: () => void;
}

const FACT_LABEL_WIDTH = 5;

export function formatFinding(finding: NonNullable<PolicyAnalysis>['findings'][number]): string {
  if (finding.kind === 'risk') {
    return `risk ${finding.level}${finding.score === undefined ? '' : ` (${finding.score})`}: ${finding.message}`;
  }
  if (finding.kind === 'path') {
    return `${finding.operation} ${finding.resolvedPath ?? finding.path}: ${finding.message}`;
  }
  if (finding.kind === 'unresolved') return `unresolved: ${finding.message}`;
  if (finding.kind === 'elevation') return `elevation (${finding.ruleId}): ${finding.message}`;
  if (finding.kind === 'blocked') return `blocked (${finding.ruleId}): ${finding.message}`;
  return `analyzer error (${finding.stageId}): ${finding.message}`;
}

/**
 * A permission request: what wants to run and why it needs approval, then
 * the choices, each picked by its key or by ↑↓ and Enter. Feedback,
 * patterns and prefixes are typed in a row inside the card.
 */
export class PermissionCard implements Card {
  private mode: Mode = { kind: 'choose' };
  private selected = 0;
  private readonly scrollState: CardScroll = { top: 0 };
  private lastBodyRows = 0;
  private lastRoom = 0;
  private readonly bypass: boolean;
  private readonly choices: Choice[];

  constructor(
    private readonly request: PendingPermission,
    private readonly onResolve: (action: PermissionDecisionAction) => void,
  ) {
    const analysis = request.policyAnalysis;
    const mandatory = Boolean(analysis);
    this.bypass =
      analysis?.findings.some(
        (finding) =>
          finding.stageId === 'os_sandbox' &&
          'ruleId' in finding &&
          finding.ruleId === 'unsandboxed',
      ) ?? false;
    const grant = analysis?.grantProposal;
    const resolve = (action: PermissionDecisionAction) => () => this.onResolve(action);
    this.choices = [
      { key: 'a', label: 'Allow once', tone: 'allow', run: resolve({ decision: 'allow' }) },
      ...(mandatory && grant
        ? [
            {
              key: this.bypass ? 'w' : 'g',
              label: `Allow + session ${grant.kind} ${grant.path}`,
              tone: 'allow' as const,
              run: resolve({ decision: 'allow_with_grant', grant }),
            },
          ]
        : []),
      ...(this.bypass
        ? [
            {
              key: 'A',
              label: 'Allow exact command…',
              tone: 'allow' as const,
              run: () =>
                this.setMode({ kind: 'scope', pattern: request.command, patternKind: 'exact' }),
            },
            {
              key: 'g',
              label: 'Allow command prefix…',
              tone: 'allow' as const,
              run: () =>
                this.setMode({ kind: 'prefix', text: request.command.trim().split(/\s+/)[0]! }),
            },
          ]
        : mandatory
          ? []
          : [
              {
                key: 'A',
                label: 'Allow & remember…',
                tone: 'allow' as const,
                run: () =>
                  this.setMode({ kind: 'scope', pattern: request.command, patternKind: 'exact' }),
              },
              {
                key: 'g',
                label: 'Allow pattern…',
                tone: 'allow' as const,
                run: () => this.setMode({ kind: 'pattern', text: request.command }),
              },
            ]),
      { key: 'd', label: 'Deny once', tone: 'deny', run: resolve({ decision: 'deny' }) },
      {
        key: 'f',
        label: 'Deny with feedback…',
        tone: 'deny',
        run: () => this.setMode({ kind: 'feedback', text: '' }),
      },
    ];
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
  }

  handleKey(event: InputEvent): void {
    const mode = this.mode;
    const typed = (value: string) =>
      this.setMode({ ...(mode as { kind: 'feedback' }), text: value } as Mode);
    if (event.type === 'paste') {
      if (mode.kind === 'feedback' || mode.kind === 'pattern' || mode.kind === 'prefix') {
        typed(mode.text + event.text.replace(/\n/g, ' '));
      }
      return;
    }
    if (event.type !== 'key') return;
    if (mode.kind === 'feedback' || mode.kind === 'pattern' || mode.kind === 'prefix') {
      if (event.name === 'enter') {
        if (mode.kind === 'feedback') {
          if (mode.text.trim()) this.onResolve({ decision: 'deny', feedback: mode.text.trim() });
          return;
        }
        this.setMode({
          kind: 'scope',
          pattern: mode.text,
          patternKind:
            mode.kind === 'prefix'
              ? 'prefix'
              : mode.text === this.request.command
                ? 'exact'
                : 'glob',
        });
      } else if (event.name === 'escape') {
        this.setMode({ kind: 'choose' });
      } else if (event.name === 'backspace') {
        typed(mode.text.slice(0, -1));
      } else if (event.text !== undefined) {
        typed(mode.text + event.text);
      }
      return;
    }
    if (mode.kind === 'scope') {
      if (event.name === 'escape') {
        this.setMode({ kind: 'choose' });
        return;
      }
      const scope = { s: 'session', p: 'project', g: 'global' }[event.text ?? ''] as
        | 'session'
        | 'project'
        | 'global'
        | undefined;
      if (scope) {
        this.onResolve({
          decision: 'allow',
          remember: {
            scope,
            pattern: mode.pattern,
            patternKind: mode.patternKind,
            ...(this.bypass ? { allowUnsandboxed: true } : {}),
          },
        });
      }
      return;
    }
    if (event.name === 'up') {
      this.selected = (this.selected + this.choices.length - 1) % this.choices.length;
    } else if (event.name === 'down') {
      this.selected = (this.selected + 1) % this.choices.length;
    } else if (event.name === 'enter') {
      this.choices[this.selected]?.run();
    } else if (event.name === 'escape') {
      this.onResolve({ decision: 'deny' });
    } else if (event.name === 'pageup' || event.name === 'pagedown') {
      this.scroll(
        event.name === 'pageup' ? -Math.max(1, this.lastRoom - 1) : Math.max(1, this.lastRoom - 1),
      );
    } else if (event.text !== undefined && /^[1-9]$/.test(event.text)) {
      this.choices[Number(event.text) - 1]?.run();
    } else if (event.text !== undefined) {
      this.choices.find((choice) => choice.key === event.text)?.run();
    }
  }

  scrollPages(pages: number): boolean {
    return this.scroll(pages * Math.max(1, this.lastRoom - 1));
  }

  scroll(lines: number): boolean {
    return scrollCard(this.scrollState, lines, this.lastBodyRows, this.lastRoom);
  }

  private facts(width: number, style: Style): string[] {
    const { request } = this;
    const room = Math.max(10, width - FACT_LABEL_WIDTH - 2);
    const fact = (label: string, value: string, tone?: 'error' | 'dim') =>
      wrapText(value, room, tone ? (text) => style.fg(tone, text) : undefined).map((line, index) =>
        index === 0
          ? factRow(label, line, FACT_LABEL_WIDTH, style)
          : `${' '.repeat(FACT_LABEL_WIDTH + 2)}${line}`,
      );
    const rows: string[] = [];
    if (request.subagent)
      rows.push(
        ...fact(
          'from',
          `subagent ${request.subagent.id.slice(-8)}: ${request.subagent.purpose}`,
          'dim',
        ),
      );
    if (request.mcp) {
      rows.push(...fact('mcp', style.bold(`${request.mcp.server} / ${request.mcp.tool}`)));
      if (request.mcp.preview.length > 0) {
        rows.push(
          ...fact(
            'args',
            request.mcp.preview.map(({ name, type }) => `${name}: ${type}`).join(', '),
          ),
        );
      }
    } else {
      rows.push(...fact('bash', style.bold(request.command)));
    }
    if (request.reason) rows.push(...fact('why', request.reason));
    if (request.reviewerReason)
      rows.push(...fact('check', `reviewer: ${request.reviewerReason}`, 'dim'));
    if (request.systemOneNote)
      rows.push(...fact('check', `System One ${request.systemOneNote}`, 'dim'));
    const analysis = request.policyAnalysis;
    for (const stage of analysis?.stages ?? [])
      rows.push(...fact('stage', `${stage.id}: ${stage.status}`, 'dim'));
    for (const finding of analysis?.findings ?? [])
      rows.push(...fact('found', formatFinding(finding), 'error'));
    if (this.bypass) {
      rows.push(
        ...fact(
          'note',
          'this command runs outside the OS sandbox; remembering it trusts the executable, not just its arguments',
          'error',
        ),
      );
    }
    if (analysis) rows.push(...fact('note', 'approval is not filesystem confinement', 'dim'));
    return rows;
  }

  render(width: number, maxRows: number, style: Style): string[] {
    const inner = cardInnerWidth(width);
    const body = this.facts(inner, style);
    const mode = this.mode;
    let footer: string[];
    let keys: string;
    if (mode.kind === 'feedback') {
      footer = ['', inputRow('feedback', mode.text, style, inner)];
      keys = 'enter deny · esc back';
    } else if (mode.kind === 'pattern' || mode.kind === 'prefix') {
      footer = ['', inputRow(mode.kind, mode.text, style, inner)];
      keys = 'enter confirm · esc back';
    } else if (mode.kind === 'scope') {
      footer = [
        '',
        `${style.fg('muted', 'remember')} ${mode.patternKind} ${style.bold(oneLine(mode.pattern))}`,
        `${style.fg('accent', 's')} session  ${style.fg('accent', 'p')} project  ${style.fg('accent', 'g')} global`,
      ];
      keys = 's/p/g · esc back';
    } else {
      footer = [
        '',
        ...this.choices.map((choice, index) =>
          choiceRow(
            index === this.selected,
            choice.key,
            choice.label,
            choice.tone === 'allow' ? 'success' : 'error',
            style,
          ),
        ),
      ];
      keys = 'key or ↑↓ enter · esc deny';
    }
    this.lastBodyRows = body.length;
    this.lastRoom = Math.max(1, maxRows - 2 - footer.length - 1);
    return renderCard(
      { title: 'approval needed', tone: 'warning', keys, body, footer },
      width,
      maxRows,
      style,
      this.scrollState,
    );
  }
}

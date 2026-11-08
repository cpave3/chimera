import { basename } from 'node:path';
import { displayPath } from '../display-path';
import type { UsageState } from '../session-events';
import { clipToWidth, displayWidth } from '../terminal/width';
import type { ColorToken } from '../theme/palette';
import type { Style } from '../theme/style';
import { formatTokens } from '../usage-format';

/** One row of the status line: items pinned to each edge. */
export interface StatusRow {
  left?: string[];
  right?: string[];
}

export interface StatusLineConfig {
  rows?: StatusRow[];
  /** A command whose output replaces the rows. */
  command?: string | null;
}

export const DEFAULT_STATUS_ROWS: StatusRow[] = [
  { left: ['model', 'context'], right: ['cwd', 'branch'] },
  { left: ['session', 'sandbox'] },
];

/** Where a session's commands run: a Docker sandbox mode, `os`, or `off`. */
export type SandboxLabel = 'off' | 'on' | 'overlay' | 'os' | (string & {});

/** The session facts the status line draws from; they change with session events. */
export interface StatusFacts {
  modelRef: string;
  /** The model this turn is routed to because it carries images. */
  visionRouteRef: string | null;
  usage: UsageState | null;
  cwd: string;
  branch: { name: string; ahead: number; behind: number } | null;
  sessionId: string;
  sandbox: SandboxLabel;
  goal: string | null;
  /** The updater's notice, when there is one. */
  update: string | null;
  /** The session's cost in US dollars, when the provider reports prices. */
  costUsd?: number | null;
}

/** A status line item: its text and tone for these facts, or null when it has nothing to say. */
export type StatusItem = (facts: StatusFacts) => { text: string; tone?: ColorToken } | null;

const MAX_GOAL = 40;
const MAX_CWD = 40;

function contextShare(usage: UsageState): number | null {
  return usage.contextWindow > 0 ? usage.usedContextTokens / usage.contextWindow : null;
}

export const STATUS_ITEMS: Record<string, StatusItem> = {
  model: (facts) => ({
    text: facts.visionRouteRef
      ? `${facts.modelRef} → ${facts.visionRouteRef} (vision)`
      : facts.modelRef,
  }),
  context: ({ usage }) => {
    if (!usage) return null;
    const share = contextShare(usage);
    const window = `${formatTokens(usage.contextWindow)}${usage.unknownWindow ? '?' : ''}`;
    if (share === null) return { text: `${formatTokens(usage.usedContextTokens)} tokens` };
    const percent = Math.round(share * 100);
    return {
      text: `${percent}%/${window}`,
      tone: percent > 90 ? 'error' : percent > 70 ? 'warning' : undefined,
    };
  },
  tokens: ({ usage }) =>
    usage
      ? {
          text: `↑${formatTokens(usage.usage.inputTokens)} ↓${formatTokens(usage.usage.outputTokens)}`,
        }
      : null,
  cost: ({ costUsd }) =>
    costUsd === undefined || costUsd === null ? null : { text: `$${costUsd.toFixed(2)}` },
  cache: ({ usage }) => {
    const last = usage?.usage.lastStep;
    if (!last || last.inputTokens <= 0 || last.cachedInputTokens <= 0) return null;
    return {
      text: `cache ${Math.min(100, Math.round((last.cachedInputTokens / last.inputTokens) * 100))}%`,
    };
  },
  cwd: ({ cwd }) => ({ text: displayPath(cwd, MAX_CWD) }),
  branch: ({ branch }) => {
    if (!branch || branch.name === '') return null;
    const counts = `${branch.ahead > 0 ? `↑${branch.ahead}` : ''}${branch.behind > 0 ? `↓${branch.behind}` : ''}`;
    return { text: counts ? `${branch.name} ${counts}` : branch.name };
  },
  session: ({ sessionId }) => ({ text: sessionId.slice(-8) }),
  sandbox: ({ sandbox }) => {
    if (sandbox === 'off') return null;
    if (sandbox === 'os') return { text: 'os sandbox' };
    if (sandbox === 'on') return { text: 'docker sandbox' };
    return { text: `${sandbox} sandbox` };
  },
  goal: ({ goal }) => (goal ? { text: `goal: ${clipToWidth(goal, MAX_GOAL)}` } : null),
  update: ({ update }) => (update ? { text: update, tone: 'info' } : null),
};

export interface StatusLine {
  /** The first row, drawn in the prompt box's bottom border. */
  border: { left: string; right: string };
  /** Further rows, drawn dim under the box. */
  below: string[];
}

const SEPARATOR = ' · ';
// `╰─ ` before the row and ` ─╯` after it; the fill takes a space each side.
const BORDER_OVERHEAD_WITH_RIGHT = 9;
const BORDER_OVERHEAD_LEFT_ONLY = 6;
/** Rows under the box start under its text. */
export const BELOW_INDENT = '   ';

interface Drawn {
  text: string;
  width: number;
}

function draw(names: string[] | undefined, facts: StatusFacts, style: Style): Drawn[] {
  return (names ?? []).flatMap((name) => {
    const item = STATUS_ITEMS[name]?.(facts);
    if (!item) return [];
    return [{ text: style.fg(item.tone ?? 'dim', item.text), width: displayWidth(item.text) }];
  });
}

function joined(items: Drawn[]): Drawn {
  return {
    text: items.map((item) => item.text).join(SEPARATOR),
    width:
      items.reduce((sum, item) => sum + item.width, 0) +
      Math.max(0, items.length - 1) * SEPARATOR.length,
  };
}

/**
 * Lay out one row: items drop from the end of each list, the right list
 * first and then whichever list has more, until the row fits.
 */
function fitRow(
  left: Drawn[],
  right: Drawn[],
  fits: (leftWidth: number, rightWidth: number, hasRight: boolean) => boolean,
): { left: Drawn[]; right: Drawn[] } {
  let keptLeft = left;
  let keptRight = right;
  while (keptLeft.length + keptRight.length > 1) {
    const leftWidth = joined(keptLeft).width;
    const rightWidth = joined(keptRight).width;
    if (fits(leftWidth, rightWidth, keptRight.length > 0)) break;
    if (keptRight.length >= keptLeft.length) keptRight = keptRight.slice(0, -1);
    else keptLeft = keptLeft.slice(0, -1);
  }
  return { left: keptLeft, right: keptRight };
}

export function renderStatusLine(
  rows: StatusRow[],
  facts: StatusFacts,
  width: number,
  style: Style,
): StatusLine {
  const [first, ...rest] = rows;
  let border = { left: '', right: '' };
  if (first) {
    const laid = fitRow(
      draw(first.left, facts, style),
      draw(first.right, facts, style),
      (l, r, hasRight) =>
        hasRight
          ? l + r + BORDER_OVERHEAD_WITH_RIGHT <= width
          : l + BORDER_OVERHEAD_LEFT_ONLY <= width,
    );
    const room =
      width - (laid.right.length > 0 ? BORDER_OVERHEAD_WITH_RIGHT : BORDER_OVERHEAD_LEFT_ONLY);
    border = {
      left: clipToWidth(joined(laid.left).text, Math.max(1, room)),
      right: joined(laid.right).text,
    };
  }
  const room = width - BELOW_INDENT.length;
  const below = rest.flatMap((row) => {
    const laid = fitRow(
      draw(row.left, facts, style),
      draw(row.right, facts, style),
      (l, r, hasRight) => (hasRight ? l + r + 1 <= room : l <= room),
    );
    const left = joined(laid.left);
    const right = joined(laid.right);
    if (left.width === 0 && right.width === 0) return [];
    if (right.width === 0) return [clipToWidth(left.text, room)];
    const gap = Math.max(1, room - left.width - right.width);
    return [clipToWidth(`${left.text}${' '.repeat(gap)}${right.text}`, room)];
  });
  return { border, below };
}

/**
 * The JSON a status line command reads on stdin: Claude Code's statusLine
 * shape where Chimera has the same fact, and Chimera's own under `chimera`.
 */
export function buildStatusPayload(
  facts: StatusFacts,
  session: { version: string; mode: string; transcriptPath?: string },
): Record<string, unknown> {
  const usage = facts.usage;
  const share = usage ? contextShare(usage) : null;
  const slash = facts.modelRef.indexOf('/');
  return {
    hook_event_name: 'Status',
    session_id: facts.sessionId,
    transcript_path: session.transcriptPath ?? null,
    cwd: facts.cwd,
    model: {
      id: facts.modelRef,
      display_name: slash >= 0 ? facts.modelRef.slice(slash + 1) : facts.modelRef,
    },
    workspace: { current_dir: facts.cwd, project_dir: facts.cwd },
    version: session.version,
    output_style: { name: session.mode },
    cost: { total_cost_usd: facts.costUsd ?? 0 },
    exceeds_200k_tokens: (usage?.usedContextTokens ?? 0) > 200_000,
    context_window: usage
      ? {
          total_input_tokens: usage.usage.inputTokens,
          total_output_tokens: usage.usage.outputTokens,
          context_window_size: usage.contextWindow,
          current_usage: usage.usage.lastStep
            ? {
                input_tokens: usage.usage.lastStep.inputTokens,
                output_tokens: usage.usage.lastStep.outputTokens,
                cache_read_input_tokens: usage.usage.lastStep.cachedInputTokens,
              }
            : null,
        }
      : null,
    chimera: {
      mode: session.mode,
      sandbox: facts.sandbox,
      branch: facts.branch?.name ?? null,
      ahead: facts.branch?.ahead ?? 0,
      behind: facts.branch?.behind ?? 0,
      goal: facts.goal,
      vision_route: facts.visionRouteRef,
      context_percent: share === null ? null : Math.round(share * 100),
      used_context_tokens: usage?.usedContextTokens ?? null,
      update: facts.update,
      project: basename(facts.cwd),
    },
  };
}

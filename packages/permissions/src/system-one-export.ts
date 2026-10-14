import { redactCommand } from './policy-review';

type LogRecord = Record<string, unknown>;

export type SystemOneLabel = 'safe' | 'unsafe';

/** One command the model rated, with the label a person gave it. */
export interface SystemOneLabelledRow extends LogRecord {
  label: SystemOneLabel;
  /** `user`: the answer to the approval prompt. `review`: a label from the review file. */
  labelSource: 'user' | 'review';
}

/**
 * One distinct command that no person decided, for a person to label. The
 * same command in another directory, or outside the OS sandbox, is another row.
 */
export interface SystemOneReviewRow {
  cwd: string;
  command: string;
  unsandboxed?: true;
  /** How many times the model rated it. */
  count: number;
  /** What the model made of it: `approved`, `rejected`, `failed`. */
  outcomes: string[];
  lowestSafety?: number;
  highestSafety?: number;
  label: SystemOneLabel | null;
}

export interface SystemOneExport {
  labelled: SystemOneLabelledRow[];
  review: SystemOneReviewRow[];
}

export interface SystemOneExportInput {
  /** The records of `system-one-decisions.jsonl`. */
  checks: LogRecord[];
  /** The records of `permission-decisions.jsonl`. */
  decisions: LogRecord[];
  /** The review rows of an earlier export, with the labels a person filled in. */
  reviewed?: LogRecord[];
}

const requestKey = (record: LogRecord) => `${record.sessionId}\n${record.requestId}`;
const commandKey = (record: LogRecord) =>
  `${record.cwd}\n${record.unsandboxed === true}\n${record.command}`;

function reviewLabel(row: LogRecord): SystemOneLabel | null {
  const { label } = row;
  if (label === 'safe' || label === 'unsafe' || label === null) return label;
  throw new Error(
    `review label of ${JSON.stringify(row.command)} must be "safe", "unsafe" or null, not ${JSON.stringify(label)}`,
  );
}

/**
 * Joins the two logs. A command that the user decided at the prompt has that
 * decision as its label. Every other command is listed once for review, and
 * has the label of an earlier review when there is one.
 */
export function exportSystemOneLog(input: SystemOneExportInput): SystemOneExport {
  const reviewLabels = new Map(
    (input.reviewed ?? []).map((row) => [commandKey(row), { row, label: reviewLabel(row) }]),
  );
  const byUser = new Map(
    input.decisions
      .filter((record) => record.source === 'user')
      .map((record) => [requestKey(record), record]),
  );
  const labelled: SystemOneLabelledRow[] = [];
  const review = new Map<string, SystemOneReviewRow>();
  // Redacted first: the review file has the redacted command, and its labels must match.
  const checks = input.checks.map(
    (record): LogRecord => ({ ...record, command: redactCommand(String(record.command)) }),
  );
  for (const checked of checks) {
    const answer = byUser.get(requestKey(checked));
    if (answer) {
      labelled.push({
        ...trainingFields(checked),
        label: answer.decision === 'allow' ? 'safe' : 'unsafe',
        labelSource: 'user',
        ...(typeof answer.feedback === 'string'
          ? { feedback: redactCommand(answer.feedback) }
          : {}),
      });
      continue;
    }
    const key = commandKey(checked);
    const reviewedLabel = reviewLabels.get(key)?.label ?? null;
    if (reviewedLabel)
      labelled.push({ ...trainingFields(checked), label: reviewedLabel, labelSource: 'review' });
    const listed = review.get(key) ?? {
      cwd: String(checked.cwd),
      command: String(checked.command),
      ...(checked.unsandboxed === true ? { unsandboxed: true as const } : {}),
      count: 0,
      outcomes: [],
      label: reviewedLabel,
    };
    listed.count += 1;
    const outcome = String(checked.outcome);
    if (!listed.outcomes.includes(outcome)) listed.outcomes.push(outcome);
    if (typeof checked.safety === 'number') {
      listed.lowestSafety = Math.min(listed.lowestSafety ?? checked.safety, checked.safety);
      listed.highestSafety = Math.max(listed.highestSafety ?? checked.safety, checked.safety);
    }
    review.set(key, listed);
  }
  // A reviewed command that has left the log keeps its row: a label is never lost.
  for (const [key, { row, label }] of reviewLabels) {
    if (label && !review.has(key))
      review.set(key, { ...(row as unknown as SystemOneReviewRow), label });
  }
  const rows = [...review.values()].map(inReviewOrder);
  return {
    labelled,
    // What still needs a label comes first.
    review: [...rows.filter((row) => row.label === null), ...rows.filter((row) => row.label)],
  };
}

/** A record of the System One log without the fields that say nothing about the command. */
function trainingFields(checked: LogRecord): LogRecord {
  const { version: _version, note: _note, url: _url, durationMs: _durationMs, ...row } = checked;
  return row;
}

/** The keys in the order a person reads them, with the label to fill in last. */
function inReviewOrder(row: SystemOneReviewRow): SystemOneReviewRow {
  const { cwd, command, unsandboxed, count, outcomes, lowestSafety, highestSafety, label } = row;
  return {
    cwd,
    command,
    ...(unsandboxed ? { unsandboxed } : {}),
    count,
    outcomes,
    ...(lowestSafety === undefined ? {} : { lowestSafety, highestSafety }),
    label,
  };
}

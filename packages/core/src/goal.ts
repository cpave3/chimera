import type { TaskItem, ToolCallRecord } from './types';

/** A completion condition the user set for a session, in the user's words. */
export interface Goal {
  condition: string;
}

export interface GoalVerdict {
  result: 'met' | 'not_met' | 'impossible';
  reason: string;
}

/**
 * What happened to a session's goal. `limit`: the run used its
 * continuations. `unchecked`: the check could not be made.
 */
export type GoalChange =
  | 'set'
  | 'cleared'
  | 'met'
  | 'not_met'
  | 'impossible'
  | 'limit'
  | 'unchecked';

/** What the goal checker reads of a session at a clean stop. */
export interface GoalEvidence {
  condition: string;
  lastAssistantMessage: string;
  tasks: TaskItem[];
  toolCalls: ToolCallRecord[];
}

export const DEFAULT_GOAL_MAX_CONTINUATIONS = 20;

// The checker can be a small model: every part of its input has a ceiling.
const RECENT_TOOL_CALLS = 15;
const MESSAGE_CHARACTERS = 4_000;
const ARGUMENT_CHARACTERS = 160;
const RESULT_CHARACTERS = 300;

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)} [cut]` : text;
}

/** The end of a tool result says how a command went: the summary line, the exit code. */
function cutStart(text: string, limit: number): string {
  return text.length > limit ? `[cut] ${text.slice(-limit)}` : text;
}

function toolCallLine(call: ToolCallRecord): string {
  const outcome =
    call.error !== undefined
      ? `error: ${cut(call.error, RESULT_CHARACTERS)}`
      : call.result === undefined
        ? 'no result'
        : cutStart(JSON.stringify(call.result), RESULT_CHARACTERS);
  return `- ${call.name} ${cut(JSON.stringify(call.args ?? {}), ARGUMENT_CHARACTERS)} → ${outcome}`;
}

function toolCallsSection(toolCalls: ToolCallRecord[]): string {
  if (toolCalls.length === 0) return '(no tool calls)';
  const earlier = toolCalls.length - RECENT_TOOL_CALLS;
  return [
    ...(earlier > 0 ? [`[${earlier} earlier tool calls are not shown]`] : []),
    ...toolCalls.slice(-RECENT_TOOL_CALLS).map(toolCallLine),
  ].join('\n');
}

const SYSTEM = `You check whether an AI coding agent has reached a goal that the user set. The agent has just stopped. You see the goal, the agent's last message, its task list and its most recent tool calls with their results.

Judge from evidence, not from what the agent says:
- "met": the tool results show that the goal's condition holds now. A test command that ran after the last change and passed is evidence. The agent's own statement is not.
- "not_met": the condition does not hold yet, or nothing shows that it holds. In the reason, tell the agent what is missing or what to do next. The agent then continues.
- "impossible": the goal cannot be reached, for example because it contradicts itself or needs access that the agent does not have, and more work will not change that.

When you are not sure between "met" and "not_met", answer "not_met".

Reply with one JSON object and nothing else:
{"result": "met" or "not_met" or "impossible", "reason": "one or two short sentences"}`;

/** The checker's input for one stop: the fixed rules and the evidence. */
export function buildGoalCheckPrompt(evidence: GoalEvidence): { system: string; prompt: string } {
  const prompt = [
    '# Goal',
    evidence.condition,
    "# The agent's last message",
    evidence.lastAssistantMessage.trim() === ''
      ? '(no message)'
      : cut(evidence.lastAssistantMessage.trim(), MESSAGE_CHARACTERS),
    "# The agent's task list",
    evidence.tasks.length === 0
      ? '(no task list)'
      : evidence.tasks.map((task) => `- [${task.status}] ${task.content}`).join('\n'),
    '# Recent tool calls, oldest first',
    toolCallsSection(evidence.toolCalls),
  ].join('\n\n');
  return { system: SYSTEM, prompt };
}

const RESULTS: Record<string, GoalVerdict['result']> = {
  met: 'met',
  not_met: 'not_met',
  impossible: 'impossible',
};

/**
 * The checker's answer in a model reply, or null when the reply has none.
 * Every flat JSON object in the reply is tried, in order, because models put
 * thinking and code fences around the answer.
 */
export function parseGoalVerdict(reply: string): GoalVerdict | null {
  for (const candidate of reply.match(/\{[^{}]*\}/g) ?? []) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const { result, reason } = parsed as { result?: unknown; reason?: unknown };
    const word =
      typeof result === 'string'
        ? RESULTS[result.toLowerCase().replace(/[\s-]+/g, '_')]
        : undefined;
    if (!word) continue;
    return {
      result: word,
      reason:
        typeof reason === 'string' && reason.trim() !== ''
          ? reason.trim()
          : 'the checker gave no reason',
    };
  }
  return null;
}

const HEADER = /^\[goal check\] not met \((\d+) of (\d+)\)$/;
const REASON_LABEL = 'What is missing: ';

/**
 * The message that tells the agent its goal is not met. It arrives in the
 * user's place in the conversation, so it says first that it is not from
 * the user. The first line is fixed in form: a client reads it back with
 * `parseGoalMessage` to show the message as one line.
 */
export function formatGoalMessage(notice: {
  condition: string;
  reason: string;
  continuation: number;
  maxContinuations: number;
}): string {
  return [
    `[goal check] not met (${notice.continuation} of ${notice.maxContinuations})`,
    'This message is from Chimera, not from the user. The user set a goal for this session, and a check of your work found that it is not met yet.',
    '',
    `Goal: ${notice.condition}`,
    `${REASON_LABEL}${notice.reason.replaceAll('\n', ' ')}`,
    '',
    'Continue the work until the goal is met. If the goal cannot be reached, say why and stop.',
  ].join('\n');
}

/** What a message made by `formatGoalMessage` says, or null for any other message. */
export function parseGoalMessage(
  content: string,
): { continuation: number; maxContinuations: number; reason: string } | null {
  const lines = content.split('\n');
  const match = HEADER.exec(lines[0] ?? '');
  if (!match) return null;
  const reasonLine = lines.find((line) => line.startsWith(REASON_LABEL));
  return {
    continuation: Number(match[1]),
    maxContinuations: Number(match[2]),
    reason: reasonLine?.slice(REASON_LABEL.length) ?? '',
  };
}

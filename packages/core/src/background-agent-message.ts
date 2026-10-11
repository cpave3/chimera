export type BackgroundAgentState = 'done' | 'failed' | 'stopped';

export interface BackgroundAgentNotice {
  id: string;
  purpose: string;
  state: BackgroundAgentState;
}

const HEADER = /^\[background agent (\S+) ended: (done|failed|stopped)\] (.*)$/;

/**
 * The message a session gets when one of its background subagents ends. It
 * arrives in the user's place in the conversation, so it says first that it
 * is not from the user. The first line is fixed in form: a client reads it
 * back with `parseBackgroundAgentMessage` to show the event as one line.
 */
export function formatBackgroundAgentMessage(
  notice: BackgroundAgentNotice & { answer: string },
): string {
  const purpose = notice.purpose.replaceAll('\n', ' ');
  return [
    `[background agent ${notice.id} ended: ${notice.state}] ${purpose}`,
    'This message is from Chimera, not from the user. The agent you started in the background has ended. Its final answer follows.',
    '',
    notice.answer.trim() === '' ? '(the agent gave no answer)' : notice.answer,
  ].join('\n');
}

/** The notice in a message made by `formatBackgroundAgentMessage`, or null for any other message. */
export function parseBackgroundAgentMessage(content: string): BackgroundAgentNotice | null {
  const match = HEADER.exec(content.split('\n', 1)[0] ?? '');
  if (!match) return null;
  return { id: match[1]!, state: match[2] as BackgroundAgentState, purpose: match[3]! };
}

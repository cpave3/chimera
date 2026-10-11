import {
  discoverAgentsFiles,
  parseBackgroundAgentMessage,
  parseGoalMessage,
  readInstructionFile,
} from '@chimera/core';
import type { ReviewContext } from '@chimera/permissions';
import type { ModelMessage } from 'ai';

/**
 * The user's own words in a conversation: the text of user-role messages.
 * Tool results and assistant text are other roles and stay out, and so does
 * what Chimera wrote into the user role for a background agent or a goal
 * check, which is a model's text.
 */
export function userMessageTexts(messages: readonly ModelMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    if (text.trim() === '' || parseBackgroundAgentMessage(text) || parseGoalMessage(text)) continue;
    texts.push(text);
  }
  return texts;
}

/** What the approval reviewer may read of a session, as it is now. */
export function reviewContext(session: {
  messages: readonly ModelMessage[];
  cwd: string;
  home?: string;
}): ReviewContext {
  return {
    userMessages: userMessageTexts(session.messages),
    instructions: discoverAgentsFiles(session.cwd, session.home).flatMap((path) => {
      const file = readInstructionFile(path);
      return file ? [{ path, content: file.content }] : [];
    }),
  };
}

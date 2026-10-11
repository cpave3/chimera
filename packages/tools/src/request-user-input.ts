import { z } from 'zod';
import type { ToolContext } from './context';
import { defineTool } from './define';

export const requestUserInputSchema = z.object({
  request: z
    .string()
    .min(1)
    .describe('Exactly what the user needs to provide or do before work can continue.'),
  kind: z.enum(['information', 'action']).optional(),
});

export type UserInputRequest = z.infer<typeof requestUserInputSchema>;

export interface RequestUserInputResult {
  waiting: true;
}

export function buildRequestUserInputTool(ctx: Pick<ToolContext, 'requestUserInput'>) {
  return defineTool<UserInputRequest, RequestUserInputResult>({
    description:
      'Request human assistance when progress genuinely requires user information or action. ' +
      'Calling this ends the current run after all tool calls already emitted in this step finish. ' +
      'Make the request specific and actionable; the user responds with their next message.',
    promptSnippet:
      'End the run and ask the user for information or an action only they can provide.',
    inputSchema: requestUserInputSchema,
    execute: async (args) => {
      const request = requestUserInputSchema.parse(args);
      await ctx.requestUserInput?.(request);
      return { waiting: true };
    },
    formatScrollback: (args) => ({ summary: args.request }),
  });
}

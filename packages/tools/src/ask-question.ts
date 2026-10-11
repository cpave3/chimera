import {
  newRequestId,
  QUESTION_LIMITS,
  type QuestionAnswer,
  type QuestionRequest,
  type QuestionResolution,
} from '@chimera/core';
import { z } from 'zod';
import { defineTool } from './define';

const optionSchema = z.object({
  label: z.string().min(1).describe('The choice, in a few words.'),
  description: z.string().optional().describe('What this choice means, when the label needs it.'),
});

const questionSchema = z.object({
  question: z.string().min(1).describe('The question, complete and specific.'),
  header: z.string().optional().describe('A label of one or two words for the question.'),
  options: z
    .array(optionSchema)
    .min(QUESTION_LIMITS.minOptions)
    .max(QUESTION_LIMITS.maxOptions)
    .describe('Two to four choices. The user can also type an answer of their own.'),
});

export const askQuestionSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(QUESTION_LIMITS.minQuestions)
    .max(QUESTION_LIMITS.maxQuestions)
    .describe('One to four questions, asked together.'),
});

export type AskQuestionArgs = z.infer<typeof askQuestionSchema>;

export type AskQuestionResult =
  | { status: 'answered'; answers: QuestionAnswer[] }
  | { status: 'cancelled' | 'unavailable'; note: string };

export interface AskQuestionContext {
  /** Puts the questions to the user. Absent where no user can answer. */
  askQuestions?: (request: QuestionRequest) => Promise<QuestionResolution>;
}

const CANCELLED_NOTE =
  'The user did not answer. Go on with the choice you judge best and say which one you made, or stop if the task cannot go on without the answer.';
const UNAVAILABLE_NOTE =
  'No user is available to answer in this session. State the assumption you make for each question and continue.';

/**
 * `ask_question`: a short multiple-choice question to the user, answered
 * within the step. For a handoff that ends the run there is
 * `request_user_input`.
 */
export function buildAskQuestionTool(ctx: AskQuestionContext) {
  return defineTool<AskQuestionArgs, AskQuestionResult>({
    description:
      'Ask the user one to four multiple-choice questions and wait for the answers; the run then ' +
      'goes on in this step. Use it when a choice changes what you build and neither the ' +
      'repository nor the conversation settles it: which of two approaches, which name, which ' +
      'scope. Do not ask what you can find out by reading, and do not ask for permission to go ' +
      'on. Each question has two to four options; the user may also type an answer of their own.',
    promptSnippet: 'Ask the user a multiple-choice question and continue with the answer.',
    inputSchema: askQuestionSchema,
    execute: async (args): Promise<AskQuestionResult> => {
      const { questions } = askQuestionSchema.parse(args);
      if (!ctx.askQuestions) return { status: 'unavailable', note: UNAVAILABLE_NOTE };
      const resolution = await ctx.askQuestions({ requestId: newRequestId(), questions });
      return resolution.status === 'answered'
        ? resolution
        : { status: 'cancelled', note: CANCELLED_NOTE };
    },
    formatScrollback: (args, result) => {
      const first = args.questions[0]?.question ?? '';
      const head = args.questions.length > 1 ? `${args.questions.length} questions` : first;
      if (!result) return { summary: head };
      if (result.status !== 'answered') {
        return {
          summary: `${head} (${result.status === 'cancelled' ? 'not answered' : 'no user'})`,
        };
      }
      return { summary: `${head} → ${result.answers.map((answer) => answer.answer).join('; ')}` };
    },
  });
}

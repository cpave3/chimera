import type { QuestionRequest, QuestionResolution } from '@chimera/core';
import { describe, expect, it } from 'vitest';
import { buildAskQuestionTool } from '../src/ask-question';

type Tool = { execute: (args: unknown, options: object) => Promise<any> };

const runner = {
  question: 'Which test runner?',
  header: 'Runner',
  options: [{ label: 'vitest', description: 'already in the repo' }, { label: 'jest' }],
};
const option = (label: string) => ({ label });

function tool(ask?: (request: QuestionRequest) => Promise<QuestionResolution>) {
  const asked: QuestionRequest[] = [];
  const built = buildAskQuestionTool({
    askQuestions: ask
      ? (request) => {
          asked.push(request);
          return ask(request);
        }
      : undefined,
  });
  const call = (args: unknown) => (built.tool as unknown as Tool).execute(args, {});
  return { call, asked, built };
}

describe('ask_question', () => {
  it('asks one question and gives the model the chosen option', async () => {
    const { call, asked } = tool(async () => ({
      status: 'answered',
      answers: [{ question: 'Which test runner?', answer: 'vitest', custom: false }],
    }));

    const result = await call({ questions: [runner] });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.questions).toEqual([runner]);
    expect(asked[0]!.requestId).toMatch(/\S/);
    expect(result).toEqual({
      status: 'answered',
      answers: [{ question: 'Which test runner?', answer: 'vitest', custom: false }],
    });
  });

  it('asks four questions in one call and keeps their order', async () => {
    const questions = ['one', 'two', 'three', 'four'].map((name) => ({
      question: `Question ${name}?`,
      options: [option('yes'), option('no')],
    }));
    const { call } = tool(async (request) => ({
      status: 'answered',
      answers: request.questions.map((question) => ({
        question: question.question,
        answer: 'yes',
        custom: false,
      })),
    }));

    const result = await call({ questions });

    expect(result.answers.map((answer: { question: string }) => answer.question)).toEqual([
      'Question one?',
      'Question two?',
      'Question three?',
      'Question four?',
    ]);
  });

  it('marks an answer the user typed', async () => {
    const { call } = tool(async () => ({
      status: 'answered',
      answers: [{ question: 'Which test runner?', answer: 'use bun test', custom: true }],
    }));

    expect((await call({ questions: [runner] })).answers[0]).toEqual({
      question: 'Which test runner?',
      answer: 'use bun test',
      custom: true,
    });
  });

  it('tells the model when the user chose not to answer', async () => {
    const { call } = tool(async () => ({ status: 'cancelled' }));

    const result = await call({ questions: [runner] });

    expect(result.status).toBe('cancelled');
    expect(result.note).toMatch(/did not answer/);
  });

  it('answers at once where there is no user, and says what to do instead', async () => {
    const { call, asked } = tool();

    const result = await call({ questions: [runner] });

    expect(asked).toEqual([]);
    expect(result.status).toBe('unavailable');
    expect(result.note).toMatch(/state the assumption/i);
  });

  it.each([
    ['no question', { questions: [] }],
    ['five questions', { questions: Array.from({ length: 5 }, () => runner) }],
    ['one option', { questions: [{ question: 'Sure?', options: [option('yes')] }] }],
    [
      'five options',
      { questions: [{ question: 'Pick', options: ['a', 'b', 'c', 'd', 'e'].map(option) }] },
    ],
    ['an empty question', { questions: [{ question: '', options: [option('a'), option('b')] }] }],
  ])('refuses %s without asking the user', async (_label, args) => {
    const { call, asked } = tool(async () => ({ status: 'cancelled' }));

    await expect(call(args)).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it('shows the first question in the transcript, and the answers once they are in', () => {
    const { built } = tool();
    const format = built.formatScrollback!;

    expect(format({ questions: [runner] }).summary).toBe('Which test runner?');
    expect(
      format(
        { questions: [runner, runner] },
        {
          status: 'answered',
          answers: [
            { question: 'Which test runner?', answer: 'vitest', custom: false },
            { question: 'Which test runner?', answer: 'jest', custom: false },
          ],
        },
      ).summary,
    ).toBe('2 questions → vitest; jest');
    expect(format({ questions: [runner] }, { status: 'cancelled', note: '' }).summary).toBe(
      'Which test runner? (not answered)',
    );
  });
});

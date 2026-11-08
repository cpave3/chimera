import type { AgentEvent, QuestionRequest, QuestionResolution } from '@chimera/core';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSession, type Mounted, mount, settle } from './harness';

const SESSION_ID = '01ABCDEFGH8AWWBRGC';

const request: QuestionRequest = {
  requestId: 'q-1',
  questions: [
    { question: 'Which test runner?', options: [{ label: 'vitest' }, { label: 'jest' }] },
  ],
};

const questionRequest = { type: 'question_request', ...request } as AgentEvent;

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** Mount on a client that records answers with their session, optionally resuming a session that waits on `pendingQuestions`. */
async function mountQuestions(pendingQuestions?: QuestionRequest[]) {
  const session = fakeSession();
  const answered: Array<[string, string, QuestionResolution]> = [];
  const client = session.client as unknown as Record<string, unknown>;
  client.answerQuestion = async (
    sessionId: string,
    requestId: string,
    resolution: QuestionResolution,
  ) => {
    answered.push([sessionId, requestId, resolution]);
  };
  if (pendingQuestions) {
    client.getSession = async () => ({
      parentId: null,
      status: 'running',
      mode: 'build',
      model: { providerId: 'manticore', modelId: 'gpt' },
      messages: [],
      pendingPermissions: [],
      pendingQuestions,
    });
  }
  mounted = await mount({ client: session.client, notifications: 'bell' });
  const ask = async (event: AgentEvent) => {
    session.push(event);
    await settle();
  };
  return { mounted, answered, ask };
}

describe('a question from the agent', () => {
  it('opens a card, and the answer goes back to the session', async () => {
    const { mounted, answered, ask } = await mountQuestions();
    await ask(questionRequest);
    const open = mounted.screen();

    await mounted.keys('2');

    expect(open).toContain('Which test runner?');
    expect(open).toContain('waiting for your answer above');
    expect(mounted.term.bells).toBe(1);
    expect(answered).toEqual([
      [
        SESSION_ID,
        'q-1',
        {
          status: 'answered',
          answers: [{ question: 'Which test runner?', answer: 'jest', custom: false }],
        },
      ],
    ]);
    expect(mounted.screen()).not.toContain('Which test runner?');
  });

  it('keeps the keys away from the prompt while the card is open', async () => {
    const { mounted, ask } = await mountQuestions();
    await ask(questionRequest);
    await mounted.keys('x');

    const rows = mounted.term.screen();
    const promptRow = rows[rows.findLastIndex((row) => row.startsWith('╭─')) + 1];

    expect(promptRow).toMatch(/^│ › waiting for your answer above +│$/);
    expect(mounted.screen()).toContain('Which test runner?');
    expect(mounted.screen()).toMatch(/^│ › x +│$/m);
    expect(mounted.session.sent).toEqual([]);
  });

  it('sends a cancellation on Esc', async () => {
    const { mounted, answered, ask } = await mountQuestions();
    await ask(questionRequest);
    await mounted.keys('\x1b', 120);

    expect(answered).toEqual([[SESSION_ID, 'q-1', { status: 'cancelled' }]]);
    expect(mounted.screen()).not.toContain('Which test runner?');
  });

  it('closes when the session says the question is settled, for example after an interrupt', async () => {
    const { mounted, answered, ask } = await mountQuestions();
    await ask(questionRequest);
    await ask({
      type: 'question_resolved',
      requestId: 'q-1',
      status: 'cancelled',
    } as AgentEvent);

    expect(mounted.screen()).not.toContain('Which test runner?');
    expect(answered).toEqual([]);
  });

  it('is shown to a client that connects while it waits', async () => {
    const { mounted } = await mountQuestions([request]);
    await settle(40);

    expect(mounted.screen()).toContain('Which test runner?');
  });
});

describe('a question taller than its card', () => {
  const tallQuestion = {
    type: 'question_request',
    requestId: 'q-tall',
    questions: [
      {
        question: Array.from({ length: 20 }, (_, i) => `line ${i + 1} of the question`).join('\n'),
        options: [{ label: 'yes' }, { label: 'no' }],
      },
    ],
  } as AgentEvent;

  it('scrolls its question with PgDn, PgUp and the wheel, keeping the choices in view', async () => {
    mounted = await mount({}, { columns: 80, rows: 24 });
    await mounted.event(tallQuestion);
    expect(mounted.screen()).toMatch(/lines 1–\d+ of 2\d/);
    expect(mounted.screen()).not.toContain('line 20 of the question');
    await mounted.keys('\x1b[6~\x1b[6~');
    expect(mounted.screen()).toMatch(/lines 11–20 of 20/);
    expect(mounted.screen()).toContain('line 20 of the question');
    expect(mounted.screen()).toContain('1. yes');
    await mounted.keys('\x1b[5~');
    expect(mounted.screen()).toMatch(/lines 2–11 of 20/);
    await mounted.keys('\x1b[<64;10;5M');
    expect(mounted.screen()).toMatch(/lines 1–10 of 20/);
  });
});

import type { ChimeraClient } from '@chimera/client';
import type { AgentEvent, QuestionRequest, QuestionResolution } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { NotificationReason } from '../src/notify';
import { fakeSession, settle } from './fullscreen-helpers';

const request: QuestionRequest = {
  requestId: 'q-1',
  questions: [
    { question: 'Which test runner?', options: [{ label: 'vitest' }, { label: 'jest' }] },
  ],
};

function mount(snapshot?: { pendingQuestions: QuestionRequest[] }) {
  const session = fakeSession();
  const answered: Array<[string, string, QuestionResolution]> = [];
  const asked: NotificationReason[] = [];
  const client = {
    ...session.client,
    answerQuestion: async (sessionId: string, requestId: string, resolution: QuestionResolution) => {
      answered.push([sessionId, requestId, resolution]);
    },
    ...(snapshot
      ? {
          getSession: async () => ({
            parentId: null,
            status: 'running',
            mode: 'build',
            model: { providerId: 'm', modelId: 'm' },
            messages: [],
            pendingPermissions: [],
            ...snapshot,
          }),
        }
      : {}),
  } as unknown as ChimeraClient;
  const rendered = render(
    <App
      client={client}
      sessionId="q-sess"
      modelRef="m/m"
      model={{ providerId: 'm', modelId: 'm', maxSteps: 50 }}
      cwd="/tmp"
      notify={(reason) => asked.push(reason)}
    />,
  );
  return { ...rendered, session, answered, asked };
}

describe('a question from the agent', () => {
  it('opens a dialog, and the answer goes back to the session', async () => {
    const { session, stdin, lastFrame, answered, asked, unmount } = mount();
    session.push({ type: 'question_request', ...request } as AgentEvent);
    await settle();
    const open = lastFrame() ?? '';

    stdin.write('2');
    await settle();
    const closed = lastFrame() ?? '';
    unmount();

    expect(open).toContain('Which test runner?');
    expect(open).toContain('waiting for your answer');
    expect(asked).toContain('input');
    expect(answered).toEqual([
      [
        'q-sess',
        'q-1',
        {
          status: 'answered',
          answers: [{ question: 'Which test runner?', answer: 'jest', custom: false }],
        },
      ],
    ]);
    expect(closed).not.toContain('Which test runner?');
  });

  it('keeps the keys away from the prompt while the dialog is open', async () => {
    const { session, stdin, lastFrame, unmount } = mount();
    session.push({ type: 'question_request', ...request } as AgentEvent);
    await settle();

    stdin.write('x');
    await settle();
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).not.toContain('> x');
    expect(frame).toContain('Which test runner?');
  });

  it('sends a cancellation on Esc', async () => {
    const { session, stdin, answered, unmount } = mount();
    session.push({ type: 'question_request', ...request } as AgentEvent);
    await settle();

    stdin.write('\x1b');
    await settle();
    unmount();

    expect(answered).toEqual([['q-sess', 'q-1', { status: 'cancelled' }]]);
  });

  it('closes when the session says the question is settled, for example after an interrupt', async () => {
    const { session, lastFrame, unmount } = mount();
    session.push({ type: 'question_request', ...request } as AgentEvent);
    await settle();
    session.push({ type: 'question_resolved', requestId: 'q-1', status: 'cancelled' } as AgentEvent);
    await settle();
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).not.toContain('Which test runner?');
  });

  it('is shown to a client that connects while it waits', async () => {
    const { lastFrame, unmount } = mount({ pendingQuestions: [request] });
    await settle(80);
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('Which test runner?');
  });
});

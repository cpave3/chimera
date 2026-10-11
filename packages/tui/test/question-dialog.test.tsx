import type { QuestionRequest, QuestionResolution } from '@chimera/core';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { QuestionDialog } from '../src/QuestionDialog';

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const DOWN = '\x1b[B';
const UP = '\x1b[A';

const runner = {
  question: 'Which test runner?',
  header: 'Runner',
  options: [
    { label: 'vitest', description: 'already in the repo' },
    { label: 'jest' },
    { label: 'node:test' },
  ],
};
const scope = {
  question: 'How far should the change go?',
  options: [{ label: 'this file' }, { label: 'the package' }],
};

function mount(request: QuestionRequest) {
  const resolved: QuestionResolution[] = [];
  const rendered = render(
    <QuestionDialog request={request} onResolve={(resolution) => resolved.push(resolution)} />,
  );
  const press = async (keys: string) => {
    rendered.stdin.write(keys);
    await settle();
  };
  const type = async (text: string) => {
    for (const character of text) {
      rendered.stdin.write(character);
      await settle(3);
    }
    await settle();
  };
  return { ...rendered, resolved, press, type };
}

describe('question dialog', () => {
  it('shows the question with its options and a row for an answer of the user', async () => {
    const { lastFrame, unmount } = mount({ requestId: 'q', questions: [runner] });
    await settle();
    const frame = lastFrame() ?? '';
    unmount();

    expect(frame).toContain('Which test runner?');
    expect(frame).toContain('1. vitest');
    expect(frame).toContain('already in the repo');
    expect(frame).toContain('2. jest');
    expect(frame).toContain('3. node:test');
    expect(frame).toContain('4. Type your own answer');
  });

  it('answers with the option under the cursor on Enter', async () => {
    const { resolved, press, unmount } = mount({ requestId: 'q', questions: [runner] });
    await settle();

    await press(DOWN);
    await press('\r');
    unmount();

    expect(resolved).toEqual([
      {
        status: 'answered',
        answers: [{ question: 'Which test runner?', answer: 'jest', custom: false }],
      },
    ]);
  });

  it('answers with the option of a digit', async () => {
    const { resolved, press, unmount } = mount({ requestId: 'q', questions: [runner] });
    await settle();

    await press('3');
    unmount();

    expect(resolved[0]).toMatchObject({ answers: [{ answer: 'node:test', custom: false }] });
  });

  it('wraps around at the ends of the list', async () => {
    const { resolved, press, unmount } = mount({ requestId: 'q', questions: [scope] });
    await settle();

    await press(UP);
    await press(UP);
    await press('\r');
    unmount();

    expect(resolved[0]).toMatchObject({ answers: [{ answer: 'the package' }] });
  });

  it('takes an answer the user types', async () => {
    const { resolved, press, type, lastFrame, unmount } = mount({
      requestId: 'q',
      questions: [runner],
    });
    await settle();

    await press('4');
    await type('use bun test');
    const typing = lastFrame() ?? '';
    await press('\r');
    unmount();

    expect(typing).toContain('use bun test');
    expect(resolved).toEqual([
      {
        status: 'answered',
        answers: [{ question: 'Which test runner?', answer: 'use bun test', custom: true }],
      },
    ]);
  });

  it('goes back from the text field to the options on Esc, without cancelling', async () => {
    const { resolved, press, type, lastFrame, unmount } = mount({
      requestId: 'q',
      questions: [runner],
    });
    await settle();

    await press('4');
    await type('never mind');
    await press('\x1b');
    const frame = lastFrame() ?? '';
    unmount();

    expect(resolved).toEqual([]);
    expect(frame).toContain('1. vitest');
  });

  it('asks several questions one after the other and sends all answers together', async () => {
    const { resolved, press, lastFrame, unmount } = mount({
      requestId: 'q',
      questions: [runner, scope],
    });
    await settle();
    const first = lastFrame() ?? '';

    await press('1');
    const second = lastFrame() ?? '';
    await press('2');
    unmount();

    expect(first).toContain('1 of 2');
    expect(second).toContain('2 of 2');
    expect(second).toContain('How far should the change go?');
    expect(resolved).toEqual([
      {
        status: 'answered',
        answers: [
          { question: 'Which test runner?', answer: 'vitest', custom: false },
          { question: 'How far should the change go?', answer: 'the package', custom: false },
        ],
      },
    ]);
  });

  it('cancels the questions on Esc', async () => {
    const { resolved, press, unmount } = mount({ requestId: 'q', questions: [runner, scope] });
    await settle();

    await press('1');
    await press('\x1b');
    unmount();

    expect(resolved).toEqual([{ status: 'cancelled' }]);
  });
});

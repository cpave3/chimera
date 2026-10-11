import { describe, expect, it } from 'vitest';
import {
  buildGoalCheckPrompt,
  formatGoalMessage,
  type GoalEvidence,
  parseGoalMessage,
  parseGoalVerdict,
} from '../src/goal';
import type { CallId } from '../src/ids';
import type { ToolCallRecord } from '../src/types';

function call(index: number, over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    callId: `C${index}` as CallId,
    name: 'bash',
    args: { command: `step ${index}` },
    target: 'host',
    result: { stdout: `output ${index}`, exit_code: 0 },
    startedAt: index,
    endedAt: index + 1,
    ...over,
  };
}

function evidence(over: Partial<GoalEvidence> = {}): GoalEvidence {
  return {
    condition: 'pnpm test passes in packages/api',
    lastAssistantMessage: 'I fixed the login test. All tests pass now.',
    tasks: [
      { content: 'find the failing test', status: 'completed' },
      { content: 'fix the handler', status: 'in_progress' },
    ],
    toolCalls: [call(1)],
    ...over,
  };
}

describe('buildGoalCheckPrompt', () => {
  it('holds the goal, the last message of the agent, the task list and the tool calls', () => {
    const { prompt } = buildGoalCheckPrompt(
      evidence({
        toolCalls: [
          call(1, {
            args: { command: 'pnpm test' },
            result: { stdout: '14 passed', exit_code: 0 },
          }),
          call(2, { name: 'edit', args: { path: 'src/login.ts' }, error: 'no match found' }),
        ],
      }),
    );

    expect(prompt).toContain('pnpm test passes in packages/api');
    expect(prompt).toContain('I fixed the login test. All tests pass now.');
    expect(prompt).toMatch(/\[completed\] find the failing test/);
    expect(prompt).toMatch(/\[in_progress\] fix the handler/);
    expect(prompt).toContain('pnpm test');
    expect(prompt).toContain('14 passed');
    expect(prompt).toContain('src/login.ts');
    expect(prompt).toMatch(/error: no match found/);
  });

  it('keeps the newest tool calls when there are many', () => {
    const toolCalls = Array.from({ length: 40 }, (_, index) => call(index + 1));

    const { prompt } = buildGoalCheckPrompt(evidence({ toolCalls }));

    expect(prompt).toContain('step 40');
    expect(prompt).toContain('step 26');
    expect(prompt).not.toContain('step 25"');
    expect(prompt).toMatch(/25 earlier tool calls are not shown/);
  });

  it('cuts a long message and long tool output', () => {
    const { prompt } = buildGoalCheckPrompt(
      evidence({
        lastAssistantMessage: 'done '.repeat(5_000),
        toolCalls: [call(1, { result: { stdout: 'line '.repeat(5_000) } })],
      }),
    );

    expect(prompt.length).toBeLessThan(12_000);
  });

  it('says so when the agent wrote nothing, has no tasks and made no tool call', () => {
    const { prompt } = buildGoalCheckPrompt(
      evidence({ lastAssistantMessage: '', tasks: [], toolCalls: [] }),
    );

    expect(prompt).toMatch(/\(no message\)/);
    expect(prompt).toMatch(/\(no task list\)/);
    expect(prompt).toMatch(/\(no tool calls\)/);
  });

  it('asks for evidence and for one of three answers', () => {
    const { system } = buildGoalCheckPrompt(evidence());

    expect(system).toMatch(/evidence/);
    expect(system).toContain('"met"');
    expect(system).toContain('"not_met"');
    expect(system).toContain('"impossible"');
    expect(system).toContain('"reason"');
  });
});

describe('parseGoalVerdict', () => {
  it('reads each of the three answers', () => {
    expect(parseGoalVerdict('{"result": "met", "reason": "the test run passed"}')).toEqual({
      result: 'met',
      reason: 'the test run passed',
    });
    expect(parseGoalVerdict('{"result":"not_met","reason":"the tests were not run"}')).toEqual({
      result: 'not_met',
      reason: 'the tests were not run',
    });
    expect(parseGoalVerdict('{"result": "impossible", "reason": "no network"}')).toEqual({
      result: 'impossible',
      reason: 'no network',
    });
  });

  it('finds the answer in a reply with other text, and takes other spellings', () => {
    expect(
      parseGoalVerdict('Thinking {about it}.\n```json\n{"result": "Not Met", "reason": "x"}\n```'),
    ).toEqual({ result: 'not_met', reason: 'x' });
    expect(parseGoalVerdict('{"result": "not-met"}')).toEqual({
      result: 'not_met',
      reason: 'the checker gave no reason',
    });
  });

  it('reads nothing from a reply with no answer it knows', () => {
    expect(parseGoalVerdict('The goal looks done.')).toBeNull();
    expect(parseGoalVerdict('{"result": "done"}')).toBeNull();
    expect(parseGoalVerdict('')).toBeNull();
  });
});

describe('the goal message to the agent', () => {
  const notice = {
    condition: 'pnpm test passes',
    reason: 'the tests were not run after the last edit',
    continuation: 2,
    maxContinuations: 20,
  };

  it('gives the reason and the goal, and says that it is not from the user', () => {
    const message = formatGoalMessage(notice);

    expect(message.split('\n')[0]).toBe('[goal check] not met (2 of 20)');
    expect(message).toMatch(/from Chimera, not from the user/);
    expect(message).toContain('the tests were not run after the last edit');
    expect(message).toContain('pnpm test passes');
  });

  it('is read back by a client, and no other message is', () => {
    expect(parseGoalMessage(formatGoalMessage(notice))).toEqual({
      continuation: 2,
      maxContinuations: 20,
      reason: 'the tests were not run after the last edit',
    });
    expect(parseGoalMessage('please check the goal')).toBeNull();
    expect(parseGoalMessage('[goal check] maybe')).toBeNull();
  });
});

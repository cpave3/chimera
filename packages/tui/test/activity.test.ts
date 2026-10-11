import { describe, expect, it } from 'vitest';
import { describeActivity, formatElapsed } from '../src/activity';

const idle = {
  awaitingApproval: false,
  compacting: false,
  retry: null,
  inFlightTool: null,
  streaming: false,
};

describe('describeActivity', () => {
  it('says the model is thinking before any output arrives', () => {
    expect(describeActivity(idle)).toBe('thinking');
  });

  it('says the model is writing while text streams', () => {
    expect(describeActivity({ ...idle, streaming: true })).toBe('writing');
  });

  it('names the command a bash call is running', () => {
    expect(
      describeActivity({ ...idle, inFlightTool: { name: 'bash', summary: 'pnpm test' } }),
    ).toBe('running pnpm test');
  });

  it('names any other tool with what it is working on', () => {
    expect(
      describeActivity({ ...idle, inFlightTool: { name: 'read', summary: 'src/agent.ts' } }),
    ).toBe('read src/agent.ts');
    expect(
      describeActivity({
        ...idle,
        inFlightTool: { name: 'mcp_docs_x', label: 'docs / search', summary: 'query' },
      }),
    ).toBe('docs / search query');
  });

  it('puts a pending approval ahead of the tool that waits on it', () => {
    expect(
      describeActivity({
        ...idle,
        awaitingApproval: true,
        inFlightTool: { name: 'bash', summary: 'git push' },
      }),
    ).toBe('waiting for approval');
  });

  it('reports compaction and provider retries', () => {
    expect(describeActivity({ ...idle, compacting: true })).toBe('compacting context');
    expect(describeActivity({ ...idle, retry: { attempt: 2, maxAttempts: 4 } })).toBe(
      'provider error, retry 2/4',
    );
  });
});

describe('formatElapsed', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(12_400)).toBe('12s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(3_723_000)).toBe('1h 02m');
  });
});

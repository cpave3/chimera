import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, type AppProps } from '../src/App';
import { fakeSession, settle, type } from './fullscreen-helpers';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'chimera-memory-command-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function run(overrides: Partial<AppProps>): Promise<string> {
  const { stdin, lastFrame, unmount } = render(
    <App
      client={fakeSession().client}
      sessionId="memory-sess"
      modelRef="m/m"
      model={{ providerId: 'm', modelId: 'm', maxSteps: 50 }}
      cwd="/tmp/project"
      {...overrides}
    />,
  );
  await settle();
  await type(stdin, '/memory');
  stdin.write('\r');
  await settle(80);
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('/memory', () => {
  it('opens the memory index in the editor, creating it first', async () => {
    const indexPath = join(directory, 'memory', 'MEMORY.md');
    const opened: Array<{ path: string; existed: boolean }> = [];

    const frame = await run({
      memoryIndexPath: indexPath,
      openFileInEditor: async ({ path }) => {
        opened.push({ path, existed: existsSync(path) });
        return { ok: true };
      },
    });

    expect(opened).toEqual([{ path: indexPath, existed: true }]);
    expect(readFileSync(indexPath, 'utf8')).toBe('# Memory index\n\n');
    expect(frame).toContain('/reload');
  });

  it('says what went wrong when the editor fails', async () => {
    const frame = await run({
      memoryIndexPath: join(directory, 'MEMORY.md'),
      openFileInEditor: async () => ({ ok: false, reason: 'editor exited with status 1' }),
    });

    expect(frame).toContain('memory: editor exited with status 1');
  });

  it('says so when project memory is not available', async () => {
    const frame = await run({});
    expect(frame).toContain('project memory is not available in this session');
  });
});

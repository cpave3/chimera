import { afterEach, describe, expect, it } from 'vitest';
import { type Mounted, mount, toolCall } from './harness';

const FILES = [
  'packages/core/src/agent.ts',
  'packages/core/test/agent.test.ts',
  'packages/server/src/agent-registry.ts',
  'README.md',
];

const DOWN = '\x1b[B';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const mountWithFiles = () => mount({ listFiles: async () => FILES });

describe('the file completion menu', () => {
  it('lists matching files and completes the word on Tab', async () => {
    mounted = await mountWithFiles();
    await mounted.keys('fix @agent', 60);
    const open = mounted.screen();

    expect(open).toMatch(/┌─ files /);
    expect(open).toContain('packages/core/src/agent.ts');
    expect(open).toContain('packages/server/src/agent-registry.ts');
    expect(open).not.toContain('README.md');

    await mounted.keys('\t');

    expect(mounted.screen()).toContain('│ › fix @packages/core/src/agent.ts');
    expect(mounted.screen()).not.toContain('agent-registry.ts');
  });

  it('accepts the selected file on Enter without sending the message', async () => {
    mounted = await mountWithFiles();
    await mounted.keys('see @agent', 60);
    await mounted.keys(DOWN);
    await mounted.keys('\r');

    expect(mounted.screen()).toContain('│ › see @packages/core/test/agent.test.ts');
    expect(mounted.session.sent).toEqual([]);
  });

  it('shows no list when nothing matches, so Enter sends the message', async () => {
    mounted = await mountWithFiles();
    await mounted.keys('ping @nobody', 60);

    expect(mounted.screen()).not.toContain('packages/');

    await mounted.keys('\r', 80);

    expect(mounted.session.sent).toEqual(['ping @nobody']);
  });

  it('closes on Escape without interrupting the run', async () => {
    mounted = await mountWithFiles();
    await mounted.event(...toolCall('c1', 'bash', { command: 'pnpm test' }, 'pnpm test'));
    await mounted.keys('see @agent', 60);
    expect(mounted.screen()).toContain('packages/core/src/agent.ts');

    await mounted.keys('\x1b', 120);

    expect(mounted.screen()).not.toContain('packages/core/src/agent.ts');
    expect(mounted.screen()).toContain('│ › see @agent');
    expect(mounted.session.interrupt).not.toHaveBeenCalled();
  });
});

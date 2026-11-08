import { afterEach, describe, expect, it } from 'vitest';
import { fakeSession, type Mounted, mount } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

/** Mount on a client that records the paths it is asked to grant, or fails with `error`. */
async function mountPathSession(error?: Error) {
  const grants: Array<{ kind: 'read' | 'write'; path: string }> = [];
  const session = fakeSession();
  Object.assign(session.client, {
    addPath: async (_sessionId: string, kind: 'read' | 'write', path: string) => {
      if (error) throw error;
      grants.push({ kind, path });
    },
  });
  mounted = await mount({ client: session.client });
  return { mounted, grants };
}

describe('/add-read-path and /add-write-path', () => {
  it('grants read access to a path and says so', async () => {
    const { mounted, grants } = await mountPathSession();
    await mounted.keys('/add-read-path /tmp\r');

    expect(grants).toEqual([{ kind: 'read', path: '/tmp' }]);
    expect(mounted.screen()).toContain('   note  /add-read-path: granted read access to /tmp');
  });

  it('grants write access to a path and says so', async () => {
    const { mounted, grants } = await mountPathSession();
    await mounted.keys('/add-write-path /tmp\r');

    expect(grants).toEqual([{ kind: 'write', path: '/tmp' }]);
    expect(mounted.screen()).toContain('   note  /add-write-path: granted write access to /tmp');
  });

  it('takes a path with spaces whole, quoted or not', async () => {
    const { mounted, grants } = await mountPathSession();
    await mounted.keys('/add-write-path "/vault/Daily  Notes"\r');
    await mounted.keys('/add-read-path /vault/My Archive\r');
    await mounted.keys('/add-read-path /vault/Old\\ Notes\r');

    expect(grants).toEqual([
      { kind: 'write', path: '/vault/Daily  Notes' },
      { kind: 'read', path: '/vault/My Archive' },
      { kind: 'read', path: '/vault/Old Notes' },
    ]);
  });

  it('shows the usage and grants nothing without a path', async () => {
    const { mounted, grants } = await mountPathSession();
    await mounted.keys('/add-read-path\r');

    expect(grants).toEqual([]);
    expect(mounted.screen()).toContain('✗ error  usage: /add-read-path <path>');
  });

  it('shows the error of the server', async () => {
    const { mounted } = await mountPathSession(new Error('path does not exist'));
    await mounted.keys('/add-read-path /does/not/exist\r');

    expect(mounted.screen()).toContain('✗ error  /add-read-path: path does not exist');
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeSession, type Mounted, mount } from './harness';

let directory: string;
let notesPath: string;
let mounted: Mounted | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'chimera-attach-'));
  notesPath = join(directory, 'notes.txt');
  writeFileSync(notesPath, 'the first note\n');
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  rmSync(directory, { recursive: true, force: true });
});

/** Mount on a client that records the paths added, and fails the calls it is told to. */
async function mountAttaching(failures: { addPath?: Error; appendMessage?: Error } = {}) {
  const session = fakeSession();
  const added: Array<{ kind: 'read' | 'write'; path: string }> = [];
  const appended: string[] = [];
  const client = session.client as unknown as Record<string, unknown>;
  client.addPath = async (_sessionId: string, kind: 'read' | 'write', path: string) => {
    added.push({ kind, path });
    if (failures.addPath) throw failures.addPath;
  };
  client.appendMessage = async (_sessionId: string, content: string) => {
    appended.push(content);
    if (failures.appendMessage) throw failures.appendMessage;
  };
  mounted = await mount({ client: session.client });
  return { mounted, session, added, appended };
}

describe('attaching a path from the prompt', () => {
  it('adds the path, appends its content, then sends the text as typed', async () => {
    const { mounted, session, added, appended } = await mountAttaching();
    await mounted.keys(`look at @${notesPath} and tell me\r`, 150);

    expect(added).toEqual([{ kind: 'read', path: notesPath }]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toContain(`[auto-attached @${notesPath}]`);
    expect(appended[0]).toContain('the first note');
    expect(session.sent).toEqual([`look at @${notesPath} and tell me`]);
  });

  it('still sends when the content cannot be appended, and says why', async () => {
    const { mounted, session } = await mountAttaching({
      appendMessage: new Error('append unavailable'),
    });
    await mounted.keys(`look at @${notesPath} and tell me\r`, 150);

    expect(session.sent).toEqual([`look at @${notesPath} and tell me`]);
    expect(mounted.screen()).toContain(`✗ error  attach ${notesPath}: append unavailable`);
  });

  it('appends nothing when the path is refused, says why, and still sends', async () => {
    const missing = join(directory, 'does-not-exist');
    const { mounted, session, added, appended } = await mountAttaching({
      addPath: Object.assign(new Error('no such file or directory'), { status: 400 }),
    });
    await mounted.keys(`look at @${missing} and tell me\r`, 150);

    expect(added).toEqual([{ kind: 'read', path: missing }]);
    expect(appended).toEqual([]);
    expect(session.sent).toEqual([`look at @${missing} and tell me`]);
    expect(mounted.screen()).toContain(`✗ error  attach ${missing}: no such file or directory`);
  });
});

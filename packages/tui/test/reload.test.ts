import { afterEach, expect, it } from 'vitest';
import { fakeSession, type Mounted, mount } from './harness';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('/reload composes the prompt for the session on screen and sends it there', async () => {
  const session = fakeSession();
  const reloaded: Array<[string, string]> = [];
  const client = session.client as unknown as Record<string, unknown>;
  client.reloadSession = async (sessionId: string, prompt: string) => {
    reloaded.push([sessionId, prompt]);
  };
  const asked: Array<{ cwd: string; sessionId: string }> = [];
  const commands = { list: () => [], collisions: () => [], reload: async () => {} };
  mounted = await mount({
    client: session.client,
    commands: commands as never,
    reloadSystemPrompt: (context) => {
      asked.push(context);
      return 'THE NEW PROMPT';
    },
  });

  await mounted.keys('/reload\r', 80);

  expect(asked).toEqual([{ cwd: '/tmp/project', sessionId: '01ABCDEFGH8AWWBRGC' }]);
  expect(reloaded).toEqual([['01ABCDEFGH8AWWBRGC', 'THE NEW PROMPT']]);
  expect(mounted.screen()).toContain('   note  system prompt reloaded.');
});

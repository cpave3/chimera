import type { ChimeraClient } from '@chimera/client';
import { render } from 'ink-testing-library';
import { expect, it } from 'vitest';
import { App } from '../src/App';
import { fakeSession, settle, type } from './fullscreen-helpers';

it('/reload composes the prompt for the session on screen and sends it there', async () => {
  const session = fakeSession();
  const reloaded: Array<[string, string]> = [];
  const client = {
    ...session.client,
    reloadSession: async (sessionId: string, prompt: string) => {
      reloaded.push([sessionId, prompt]);
    },
  } as unknown as ChimeraClient;
  const asked: Array<{ cwd: string; sessionId: string }> = [];
  const commands = {
    list: () => [],
    collisions: () => [],
    reload: async () => {},
  };
  const { stdin, lastFrame, unmount } = render(
    <App
      client={client}
      sessionId="sess-on-screen"
      modelRef="m/m"
      model={{ providerId: 'm', modelId: 'm', maxSteps: 50 }}
      cwd="/tmp/project"
      commands={commands as never}
      reloadSystemPrompt={(context) => {
        asked.push(context);
        return 'THE NEW PROMPT';
      }}
    />,
  );
  await settle();

  await type(stdin, '/reload');
  stdin.write('\r');
  await settle(80);
  const frame = lastFrame();
  unmount();

  expect(asked).toEqual([{ cwd: '/tmp/project', sessionId: 'sess-on-screen' }]);
  expect(reloaded).toEqual([['sess-on-screen', 'THE NEW PROMPT']]);
  expect(frame).toContain('system prompt reloaded.');
});

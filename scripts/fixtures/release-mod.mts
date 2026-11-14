import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Register } from './chimera-mod-api.d.ts';

export const register: Register = (on) => {
  for (const type of ['session.start', 'turn.start', 'turn.complete', 'session.end'] as const) {
    on(type, async ($) => {
      const directory = $.env.get('CHIMERA_SMOKE_RESULTS');
      const name = $.store.directory.split(/[\\/]/).at(-1);
      if (!directory || !name) throw new Error('smoke fixture paths unavailable');
      if (type === 'session.start') {
        const serverUrl = $.server.url();
        const authenticated = await $.http.fetch(`${serverUrl}/v1/instance`);
        const anonymous = await $.http.fetch(`${new URL(serverUrl).origin}/v1/instance`);
        const instance = authenticated.ok ? await authenticated.json() : null;
        const child = $.process.spawn({
          argv: [
            $.env.get('CHIMERA_SMOKE_NODE') ?? 'node',
            '-e',
            "process.stdout.write(process.env.CHIMERA_SERVER_SECRET === undefined ? 'clean' : 'leaked'); process.stderr.write('helper-stderr');",
          ],
        });
        let stdout = '';
        let stderr = '';
        for await (const chunk of child.output) {
          if (chunk.stream === 'stdout') stdout += chunk.text;
          else stderr += chunk.text;
        }
        const exit = await child.exitPromise;
        await $.store.set('release-smoke', 'stored');
        appendFileSync(
          join(directory, `${name}.jsonl`),
          `${JSON.stringify({
            authenticated: authenticated.status === 200 && instance?.pid === process.pid,
            anonymousDenied: anonymous.status === 404,
            secretRemoved: $.env.get('CHIMERA_SERVER_SECRET') === undefined,
            helperClean: stdout === 'clean' && stderr === 'helper-stderr',
            helperExited: exit.code === 0 && exit.signal === null,
            storeRoundTrip: (await $.store.get('release-smoke')) === 'stored',
          })}\n`,
        );
      }
      appendFileSync(
        join(directory, `${name}.jsonl`),
        `${JSON.stringify({
          type,
          version: $.chimera.version,
          apiVersion: $.api.version,
          sessionId: $.session.id,
          isSubagent: $.session.isSubagent,
          parentId: $.session.parentId,
        })}\n`,
      );
    });
  }
};

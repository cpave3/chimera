import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModHost } from '@chimera/mods';
import { expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';

it('routes the factory gate through real permission mods and audits their decisions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chimera-mod-permissions-'));
  const folder = join(home, 'mod');
  await mkdir(folder);
  await writeFile(
    join(folder, 'chimera-mod.json'),
    JSON.stringify({
      name: 'permission-fixture',
      version: '1',
      apiVersion: 1,
      module: 'index.mjs',
    }),
  );
  await writeFile(
    join(folder, 'index.mjs'),
    `
    export function register(on) {
      on('permission.request', async ($, event, next) => {
        if (!event.sessionId || event.type !== 'permission.request') throw new Error('missing context');
        if (event.toolName === 'mcp' && event.args.query === 'private') {
          return {decision: 'deny', message: 'frozen by mod'};
        }
        if (event.args.command === 'echo approved') return 'allow';
        return next();
      });
    }
  `,
  );
  const mods = await ModHost.create({ folders: [folder], sessionContext: () => ({ session: {} }) });
  const factory = new CliAgentFactory({
    mods,
    home,
    autoApprove: 'none',
    mcpHeadlessAutoDeny: true,
    subagents: { enabled: false, headlessAutoDeny: true },
    diagnostics: { enabled: false },
    providersConfig: {
      providers: {
        fixture: {
          shape: 'openai',
          adapter: 'compatible',
          baseUrl: 'https://example.invalid',
          apiKey: 'test',
        },
      },
    },
  });
  try {
    const { gate } = await factory.build({
      cwd: home,
      sandboxMode: 'off',
      model: { providerId: 'fixture', modelId: 'test', maxSteps: 1 },
    });
    await expect(
      gate.request({
        requestId: 'allow',
        tool: 'bash',
        target: 'host',
        command: 'echo approved',
        cwd: home,
      }),
    ).resolves.toMatchObject({ decision: 'allow' });
    await expect(
      gate.requestMcp({
        requestId: 'deny',
        server: 'test',
        tool: 'write',
        args: { query: 'private' },
        cwd: home,
      }),
    ).resolves.toMatchObject({
      decision: 'deny',
      denialSource: 'mod',
      feedback: 'frozen by mod',
    });
    await expect(
      gate.requestMcp({ requestId: 'pass', server: 'test', tool: 'other', args: {}, cwd: home }),
    ).resolves.toMatchObject({ decision: 'deny', denialSource: 'headless' });
    const audit = await readFile(join(home, '.chimera/logs/permission-decisions.jsonl'), 'utf8');
    expect(audit).toContain('"source":"mod"');
    expect(audit).toContain('echo approved');
  } finally {
    await factory.dispose();
    await mods.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});

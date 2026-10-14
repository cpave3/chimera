import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSystemOneCheck, DefaultPermissionGate } from '@chimera/permissions';
import { buildTools, createOsSandbox, detectOsSandbox, LocalExecutor } from '@chimera/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface BashTool {
  inputSchema: { parse: (args: unknown) => Record<string, unknown> };
  execute: (args: Record<string, unknown>, options: object) => Promise<unknown>;
}

/** A System One server that gives every harmless reading this probability. */
function serverRating(benign: number) {
  const commands: string[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    commands.push(JSON.parse(String(init.body)).state.bash_command);
    const rest = 1 - benign;
    return new Response(
      JSON.stringify({
        answers: {
          damage: { probabilities: { '0': 0, '1': benign, '2': rest } },
          kind: { probabilities: { develops: benign, destroys: rest } },
          verdict: { probabilities: { safe: benign, unsafe: rest } },
        },
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, commands };
}

describe.skipIf(detectOsSandbox() !== 'bwrap')('System One and the OS sandbox', () => {
  let cwd: string;
  let protectedDirectory: string;
  let target: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-system-one-sandbox-'));
    protectedDirectory = join(cwd, '.chimera');
    target = join(protectedDirectory, 'host-state');
    await mkdir(protectedDirectory);
    await mkdir(join(cwd, 'sandbox-tmp'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** The bash tool of a session whose sandbox cannot write the protected directory. */
  function bash(benign: number, allowSandboxBypass: boolean) {
    const server = serverRating(benign);
    let prompts = 0;
    const gate = new DefaultPermissionGate({
      cwd,
      home: cwd,
      autoApprove: 'all',
      raiseRequest: async () => {
        prompts += 1;
        return { decision: 'deny', remembered: false };
      },
      systemOne: createSystemOneCheck({
        url: 'http://system-one.test/v1/systemone',
        threshold: 0.8,
        allowSandboxBypass,
        fetch: server.fetch,
      }),
    });
    const executor = new LocalExecutor({ cwd });
    const tools = buildTools({
      sandboxExecutor: executor,
      hostExecutor: executor,
      permissionGate: gate,
      sandboxMode: 'off',
      osSandbox: createOsSandbox('bwrap', {
        cwd,
        tmp: join(cwd, 'sandbox-tmp'),
        writablePaths: [],
        readOnlyPaths: [protectedDirectory],
        network: 'on',
      }),
    }).tools as unknown as Record<string, BashTool>;
    const run = (args: Record<string, unknown>) =>
      tools.bash!.execute(tools.bash!.inputSchema.parse(args), {});
    return { run, server, prompts: () => prompts };
  }

  it('retries on the host a command the sandbox stopped and the model rates safe', async () => {
    const { run, server, prompts } = bash(0.9, true);

    const result = await run({ command: `touch '${target}'` });

    expect(result).toMatchObject({ exit_code: 0, sandbox_retry: { initial_exit_code: 1 } });
    await access(target);
    expect(server.commands).toEqual([`touch '${target}'`]);
    expect(prompts()).toBe(0);
  });

  it('leaves a stopped command stopped when the model rates it unsafe', async () => {
    const { run, prompts } = bash(0.2, true);

    const result = await run({ command: `touch '${target}'` });

    expect(result).toMatchObject({ exit_code: 1 });
    expect(result).not.toHaveProperty('sandbox_retry');
    await expect(access(target)).rejects.toThrow();
    expect(prompts()).toBe(0);
  });

  it('runs outside the sandbox a command the agent asks to and the model rates safe', async () => {
    const { run, prompts } = bash(0.9, true);

    const result = await run({
      command: `touch '${target}'`,
      unsandboxed: true,
      reason: 'writes session state',
    });

    expect(result).toMatchObject({ exit_code: 0 });
    await access(target);
    expect(prompts()).toBe(0);
  });

  it('asks the user about every bypass when the setting does not allow one', async () => {
    const { run, server, prompts } = bash(0.9, false);

    const stopped = await run({ command: `touch '${target}'` });
    const asked = await run({
      command: `touch '${target}'`,
      unsandboxed: true,
      reason: 'writes session state',
    });

    expect(stopped).toMatchObject({ exit_code: 1 });
    expect(asked).toMatchObject({ exit_code: -1, stderr: 'denied by user' });
    expect(server.commands).toEqual([]);
    expect(prompts()).toBe(1);
  });
});

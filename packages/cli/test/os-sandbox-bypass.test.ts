import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPermissionGate } from '@chimera/permissions';
import {
  BackgroundProcessManager,
  buildTools,
  createOsSandbox,
  detectOsSandbox,
  LocalExecutor,
} from '@chimera/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliAgentFactory } from '../src/factory';

interface BashTool {
  inputSchema: { parse: (args: unknown) => Record<string, unknown> };
  execute: (args: Record<string, unknown>, options: object) => Promise<unknown>;
}

describe('OS sandbox bypass through the CLI factory', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-bypass-factory-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.skipIf(detectOsSandbox() !== 'bwrap').each([false, true])(
    'automatically retries a registered sandboxed write under a saved bypass rule (background=%s)',
    async (background) => {
      const protectedDirectory = join(cwd, '.chimera');
      const sandboxTmp = join(cwd, 'sandbox-tmp');
      await mkdir(protectedDirectory);
      await mkdir(sandboxTmp);
      let prompts = 0;
      const gate = new DefaultPermissionGate({
        cwd,
        home: cwd,
        autoApprove: 'all',
        raiseRequest: async () => {
          prompts++;
          return { decision: 'deny', remembered: false };
        },
      });
      gate.addRule(
        {
          tool: 'bash',
          target: 'host',
          pattern: 'touch',
          patternKind: 'prefix',
          allowUnsandboxed: true,
          decision: 'allow',
          createdAt: 1,
        },
        'session',
      );
      const executor = new LocalExecutor({ cwd });
      const manager = new BackgroundProcessManager({ cwd });
      const tools = buildTools({
        sandboxExecutor: executor,
        hostExecutor: executor,
        permissionGate: gate,
        sandboxMode: 'off',
        toolCallShape: 'codex',
        backgroundProcesses: manager,
        osSandbox: createOsSandbox('bwrap', {
          cwd,
          tmp: sandboxTmp,
          writablePaths: [],
          readOnlyPaths: [protectedDirectory],
          network: 'on',
        }),
      }).tools as unknown as Record<string, BashTool>;
      const target = join(protectedDirectory, 'automatic-host-state');
      try {
        let result = await tools.bash!.execute(
          tools.bash!.inputSchema.parse({
            command: `touch '${target}'`,
            run_in_background: background,
          }),
          {},
        );
        if (background) {
          const { shell_id: shellId } = result as { shell_id: string };
          await expect.poll(() => manager.get(shellId)?.status).toBe('exited');
          result = await tools.bash_output!.execute({ shell_id: shellId }, {});
        }
        expect(result).toMatchObject({
          exit_code: 0,
          sandbox_retry: {
            initial_exit_code: 1,
            reason: expect.stringContaining('Automatic host retry'),
          },
        });
        if (background)
          expect(result).toMatchObject({ stderr: expect.stringMatching(/Read-only file system/) });
        else
          expect(result).toMatchObject({
            sandbox_retry: { initial_stderr: expect.stringMatching(/Read-only file system/) },
          });
        await access(target);
        expect(prompts).toBe(0);
      } finally {
        manager.killAll();
      }
    },
  );

  it.skipIf(detectOsSandbox() !== 'bwrap').each([false, true])(
    'blocks a registered Codex write, then admits an explicitly remembered bypass (background=%s)',
    async (background) => {
      const protectedDirectory = join(cwd, '.chimera');
      const sandboxTmp = join(cwd, 'sandbox-tmp');
      await mkdir(protectedDirectory);
      await mkdir(sandboxTmp);
      let approvals = 0;
      const gate = new DefaultPermissionGate({
        cwd,
        home: cwd,
        autoApprove: 'all',
        raiseRequest: async (request) => {
          approvals++;
          gate.applyRemember(
            {
              scope: 'session',
              pattern: 'touch',
              patternKind: 'prefix',
              allowUnsandboxed: true,
            },
            request,
            'allow',
          );
          return { decision: 'allow', remembered: true };
        },
      });
      const executor = new LocalExecutor({ cwd });
      const manager = new BackgroundProcessManager({ cwd });
      const tools = buildTools({
        sandboxExecutor: executor,
        hostExecutor: executor,
        permissionGate: gate,
        sandboxMode: 'off',
        toolCallShape: 'codex',
        backgroundProcesses: manager,
        osSandbox: createOsSandbox('bwrap', {
          cwd,
          tmp: sandboxTmp,
          writablePaths: [],
          readOnlyPaths: [protectedDirectory],
          network: 'on',
        }),
      }).tools as unknown as Record<string, BashTool>;
      const target = join(protectedDirectory, 'host-state');
      const execute = async (command: string, bypass: boolean) => {
        const result = await tools.bash!.execute(
          tools.bash!.inputSchema.parse({
            command,
            run_in_background: background,
            ...(bypass ? { unsandboxed: true, reason: 'write protected host state' } : {}),
          }),
          {},
        );
        if (!background) return result;
        const { shell_id: shellId } = result as { shell_id: string };
        await expect.poll(() => manager.get(shellId)?.status).toBe('exited');
        return tools.bash_output!.execute({ shell_id: shellId }, {});
      };
      try {
        const command = `touch '${target}'`;
        const blocked = await execute(command, false);
        expect(blocked).toMatchObject({ stderr: expect.stringMatching(/Read-only file system/) });
        await expect(access(target)).rejects.toThrow();
        expect(approvals).toBe(0);
        await expect(execute(command, true)).resolves.toMatchObject({ exit_code: 0 });
        await access(target);
        const nextTarget = join(protectedDirectory, 'second-host-state');
        await expect(execute(`touch '${nextTarget}'`, true)).resolves.toMatchObject({
          exit_code: 0,
        });
        await access(nextTarget);
        expect(approvals).toBe(1);
      } finally {
        await manager.killAll();
      }
    },
  );

  it('forwards a Codex bypass, remembers approval, and uses it after session restart', async () => {
    const factory = new CliAgentFactory({
      providersConfig: {
        providers: {
          direct: {
            shape: 'openai',
            adapter: 'compatible',
            baseUrl: 'https://example.invalid',
            apiKey: 'test',
          },
        },
      },
      home: cwd,
      autoApprove: 'all',
      hostBashPolicy: {
        enabled: false,
        mode: 'balanced',
        autoAllowThrough: 'safe',
        osSandbox: 'required',
        network: 'on',
        sandboxWritePaths: [],
      },
      detectOsSandbox: () => 'bwrap',
      subagents: { enabled: false },
    });
    const init = {
      cwd,
      model: {
        providerId: 'direct',
        modelId: 'custom',
        maxSteps: 1,
        toolCallShape: 'codex' as const,
      },
      sandboxMode: 'off' as const,
    };
    const { agent } = await factory.build(init);
    const bash = (agent as unknown as { opts: { tools: { bash: BashTool } } }).opts.tools.bash;
    const target = join(cwd, '.chimera', 'host-state');
    const args = bash.inputSchema.parse({
      command: `touch '${target}'`,
      unsandboxed: true,
      reason: 'write host application state',
    });
    const execution = bash.execute(args, {});
    await expect.poll(() => agent.pendingPermissionRequests().length).toBe(1);
    const pending = agent.pendingPermissionRequests()[0]!;
    expect(pending).toMatchObject({ unsandboxed: true, reason: args.reason });
    expect(pending.policyAnalysis?.findings).toContainEqual(
      expect.objectContaining({ ruleId: 'unsandboxed' }),
    );
    await agent.resolvePermission(pending.requestId, 'allow', {
      scope: 'project',
      pattern: 'touch',
      patternKind: 'prefix',
      allowUnsandboxed: true,
    });
    await expect(execution).resolves.toMatchObject({ exit_code: 0 });
    await access(target);

    const { agent: restarted } = await factory.build(init);
    const restartedBash = (restarted as unknown as { opts: { tools: { bash: BashTool } } }).opts
      .tools.bash;
    const secondTarget = join(cwd, '.chimera', 'more-host-state');
    await expect(
      restartedBash.execute(
        restartedBash.inputSchema.parse({
          command: `touch '${secondTarget}'`,
          unsandboxed: true,
          reason: 'write more host state',
        }),
        {},
      ),
    ).resolves.toMatchObject({ exit_code: 0 });
    await access(secondTarget);
    expect(restarted.pendingPermissionRequests()).toEqual([]);
    const records = (
      await readFile(join(cwd, '.chimera', 'logs', 'permission-decisions.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.source)).toEqual(['user', 'rule']);
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCommands } from '@chimera/commands';
import type { ModBundle } from '@chimera/core';
import { loadModes } from '@chimera/modes';
import { ModHost, type ModRecord } from '@chimera/mods';
import { loadSkills } from '@chimera/skills';
import { loadAgents } from '@chimera/subagents';
import { z } from 'zod';
import declarations from '../../../mod-api/dist/declarations.json';
import type {
  ModCall,
  ModContext,
  ModEmission,
  ModEvent,
  ModTestHarness,
  On,
  ProcessHandle,
  ProcessOptions,
  Register,
} from '../../../mod-api/index';
import { VERSION } from '../version';

export interface ModCommandOptions {
  json?: boolean;
  stdout?: { write(text: string): unknown };
  stderr?: { write(text: string): unknown };
}

export async function runModTypes(options: ModCommandOptions = {}): Promise<number> {
  (options.stdout ?? process.stdout).write(declarations);
  return 0;
}

export interface ModListOptions extends ModCommandOptions {
  modDirs?: string[];
  envDirs?: string;
  userDirectory?: string;
  disabled?: readonly string[];
  mods?: boolean;
}

interface BundledItems {
  mcpServers: string[];
  skills: string[];
  commands: string[];
  agents: string[];
  modes: string[];
}

const bundleManifest = z.object({
  description: z.string().optional(),
  skills: z.string().min(1).optional(),
  commands: z.string().min(1).optional(),
  agents: z.string().min(1).optional(),
  modes: z.string().min(1).optional(),
  mcpServers: z
    .record(
      z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
      z.discriminatedUnion('transport', [
        z
          .object({
            transport: z.literal('stdio'),
            command: z.string().min(1),
            args: z.array(z.string()).optional(),
            env: z.record(z.string(), z.string()).optional(),
            trustedTools: z.array(z.string()).optional(),
            subagents: z.boolean().optional(),
          })
          .strict(),
        z
          .object({
            transport: z.literal('http'),
            url: z.url().refine((value) => {
              const url = new URL(value);
              return (
                url.username === '' &&
                url.password === '' &&
                url.hash === '' &&
                (url.protocol === 'https:' ||
                  (url.protocol === 'http:' &&
                    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
              );
            }, 'Must use HTTPS (HTTP only on loopback), without credentials or fragment'),
            clientId: z.string().optional(),
            trustedTools: z.array(z.string()).optional(),
            subagents: z.boolean().optional(),
          })
          .strict(),
      ]),
    )
    .optional(),
});

async function bundledItems(record: ModRecord): Promise<BundledItems> {
  const manifest = bundleManifest.parse(record.manifest);
  for (const kind of ['skills', 'commands', 'agents', 'modes'] as const) {
    const path = manifest[kind];
    if (path === undefined) continue;
    const directory = resolve(record.folder, path);
    if (directory !== record.folder && !directory.startsWith(record.folder + sep))
      throw new Error(`${kind} must be a directory inside the mod folder`);
    if (!(await stat(directory)).isDirectory())
      throw new Error(`${kind}: not a directory: ${directory}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'chimera-mod-bundle-check-'));
  try {
    const warnings: string[] = [];
    const options = {
      cwd: temporary,
      userHome: temporary,
      includeClaudeCompat: false,
      includeCodexCompat: false,
      includeAgentsCompat: false,
      modBundles: [
        { name: record.name!, directory: record.folder, manifest },
      ] satisfies ModBundle[],
      onWarning: (message: string) => {
        warnings.push(message);
      },
    };
    const fromMod = (items: readonly { source: string; name: string }[]) =>
      items.filter((item) => item.source === `mod:${record.name}`).map((item) => item.name);
    const result = {
      mcpServers: Object.keys(manifest.mcpServers ?? {}),
      commands: fromMod(loadCommands(options).list()),
      skills: fromMod(loadSkills(options).all()),
      agents: fromMod(loadAgents(options).all()),
      modes: fromMod(loadModes(options).all()),
    };
    const bundleWarnings = warnings.filter((message) => message.includes(record.folder));
    if (bundleWarnings.length) throw new Error(bundleWarnings.join('\n'));
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function authorHost(options: ModListOptions): Promise<ModHost> {
  return ModHost.create({
    folders: options.modDirs,
    envDirs: options.envDirs,
    userDirectory: options.userDirectory,
    disabled: options.disabled,
    noMods: options.mods === false,
    sessionContext: () => ({}),
    version: VERSION,
  });
}

export async function runModList(options: ModListOptions = {}): Promise<number> {
  const host = await authorHost(options);
  try {
    const records = await Promise.all(
      host.mods.map(async (record) => {
        let bundled: BundledItems | undefined;
        let bundleError: string | undefined;
        if (record.manifest) {
          try {
            bundled = await bundledItems(record);
          } catch (error) {
            bundleError = error instanceof Error ? error.message : String(error);
          }
        }
        return { ...record, bundled, bundleError };
      }),
    );
    const stdout = options.stdout ?? process.stdout;
    if (options.json) stdout.write(`${JSON.stringify(records)}\n`);
    else
      for (const record of records) {
        stdout.write(
          `${record.name ?? '(unknown)'} ${record.version ?? ''} ${record.status} ${record.source} ${record.folder}\n`,
        );
        if (record.error) stdout.write(`  ${record.error}\n`);
        if (record.bundleError) stdout.write(`  bundles: ${record.bundleError}\n`);
        if (record.hooks.length) stdout.write(`  hooks: ${record.hooks.join(', ')}\n`);
        if (record.bundled)
          for (const [kind, names] of Object.entries(record.bundled)) {
            if (names.length) stdout.write(`  ${kind}: ${names.join(', ')}\n`);
          }
      }
    return 0;
  } finally {
    await host.shutdown();
  }
}

export async function runModValidate(
  directory: string,
  options: ModCommandOptions = {},
): Promise<number> {
  const host = await authorHost({
    modDirs: [directory],
    envDirs: '',
    userDirectory: join(tmpdir(), `chimera-no-user-mods-${randomUUID()}`),
  });
  try {
    const record = host.mods[0];
    let error = record.error;
    let bundled: BundledItems | undefined;
    if (record.status === 'loaded') {
      try {
        bundled = await bundledItems(record);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
    const valid = record.status === 'loaded' && error === undefined;
    const report = {
      valid,
      folder: record.folder,
      name: record.name,
      hooks: record.hooks,
      bundled,
      error,
    };
    if (options.json) (options.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`);
    else if (valid) (options.stdout ?? process.stdout).write(`Valid mod: ${record.name}\n`);
    else
      (options.stderr ?? process.stderr).write(
        `Invalid mod ${record.name ?? directory}: ${error ?? record.status}\n`,
      );
    return valid ? 0 : 1;
  } finally {
    await host.shutdown();
  }
}

const INTERCEPTORS = new Set([
  'tool.call',
  'permission.request',
  'turn.step',
  'prompt.submit',
  'turn.stop',
]);

async function testHarness(register: Register): Promise<ModTestHarness> {
  const calls: ModCall[] = [];
  const results: ModEmission[] = [];
  const processes: ProcessOptions[] = [];
  const values = new Map<string, unknown>();
  const environment = new Map<string, string>();
  const store = new Map<string, unknown>();
  const hooks: {
    name: string;
    handler: ($: ModContext, event: ModEvent, next: () => Promise<unknown>) => unknown;
  }[] = [];
  const call = (path: string, args: unknown[], fallback: () => unknown): unknown => {
    calls.push({ path, args });
    return values.has(path) ? values.get(path) : fallback();
  };
  const fakeProcess = (index: number): ProcessHandle => {
    const prefix = `process[${index}]`;
    return {
      write: async (text) => {
        await call(`${prefix}.write`, [text], () => undefined);
      },
      close: () => {
        call(`${prefix}.close`, [], () => undefined);
      },
      kill: (signal) => {
        call(`${prefix}.kill`, [signal], () => undefined);
      },
      output: { async *[Symbol.asyncIterator]() {} },
      exitPromise: Promise.resolve({ code: 0, signal: null }),
    };
  };
  const context: ModContext = {
    chimera: { version: VERSION },
    api: { version: 1 },
    session: {
      id: 'test',
      name: 'test',
      cwd: '/test',
      status: 'idle',
      parentId: null,
      isSubagent: false,
      model: { providerId: 'test', modelId: 'model', maxSteps: 1 },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
        stepCount: 0,
      },
      messages: () =>
        call('session.messages', [], () => []) as ReturnType<ModContext['session']['messages']>,
    },
    server: { url: () => call('server.url', [], () => 'http://test.invalid') as string },
    prompt: {
      submit: async (input) =>
        call('prompt.submit', [input], () => ({ accepted: true })) as Awaited<
          ReturnType<ModContext['prompt']['submit']>
        >,
    },
    message: {
      append: async (text) => {
        await call('message.append', [text], () => undefined);
      },
    },
    turn: {
      abort: () => {
        call('turn.abort', [], () => undefined);
      },
    },
    process: {
      spawn: (options) => {
        const index = processes.push(structuredClone(options)) - 1;
        return call('process.spawn', [options], () => fakeProcess(index)) as ProcessHandle;
      },
    },
    http: {
      fetch: async (...args) => call('http.fetch', args, () => new Response('')) as Response,
    },
    env: {
      get: (name) => call('env.get', [name], () => environment.get(name)) as string | undefined,
      set: (name, value) => {
        call('env.set', [name, value], () =>
          value === undefined ? environment.delete(name) : environment.set(name, value),
        );
      },
    },
    clock: {
      now: () => call('clock.now', [], () => 0) as number,
      sleep: async (milliseconds) => {
        await call('clock.sleep', [milliseconds], () => undefined);
      },
    },
    ui: {
      log: (text, options) => {
        call('ui.log', [text, options], () => undefined);
      },
    },
    store: {
      directory: '/test/mod-data',
      get: async <T>(key: string) =>
        call('store.get', [key], () => store.get(key)) as T | undefined,
      set: async (key, value) => {
        await call('store.set', [key, value], () => store.set(key, structuredClone(value)));
      },
      delete: async (key) => {
        await call('store.delete', [key], () => store.delete(key));
      },
    },
  };
  const on: On = (name, handler) => {
    hooks.push({ name, handler: handler as (typeof hooks)[number]['handler'] });
  };
  await register(on);
  return {
    $: context,
    calls,
    results,
    processes,
    setResult(path, result) {
      if (/^process\[\d+\]\.(write|close|kill)$/.test(path)) {
        values.set(path, result);
        return;
      }
      const keys = path.split('.');
      const key = keys.pop()!;
      let target: object = context;
      for (const part of keys) {
        const value = Reflect.get(target, part);
        if (!value || typeof value !== 'object') throw new Error(`Unknown fake API path: ${path}`);
        target = value;
      }
      if (!Object.hasOwn(target, key)) throw new Error(`Unknown fake API path: ${path}`);
      if (typeof Reflect.get(target, key) === 'function') values.set(path, result);
      else Reflect.set(target, key, result);
    },
    async emit(event, terminalResult) {
      const matching = hooks.filter((hook) => hook.name === event.type);
      const invoke = async (index: number): Promise<unknown> => {
        if (index === matching.length) return terminalResult;
        let downstream: Promise<unknown> | undefined;
        const next = () => {
          if (downstream) throw new Error('next() called twice');
          downstream = invoke(index + 1);
          return downstream;
        };
        const result = await matching[index].handler(context, event, next);
        if (!INTERCEPTORS.has(event.type)) await (downstream ?? invoke(index + 1));
        return result;
      };
      const result = await invoke(0);
      results.push({ event: structuredClone(event), result });
      return result;
    },
  };
}

export async function runModTest(
  directory: string,
  options: ModCommandOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const host = await authorHost({
    modDirs: [directory],
    envDirs: '',
    userDirectory: join(tmpdir(), `chimera-no-user-mods-${randomUUID()}`),
  });
  try {
    const record = host.mods[0];
    if (record.status !== 'loaded') throw new Error(record.error ?? record.status);
    const files = (await readdir(join(directory, 'tests')))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort();
    if (!files.length) throw new Error('No tests/*.test.mjs found');
    let failures = 0;
    for (const filename of files) {
      try {
        const module =
          record.manifest!.module === undefined
            ? { register: () => {} }
            : await import(
                /* @vite-ignore */ `${pathToFileURL(resolve(directory, record.manifest!.module)).href}?test=${randomUUID()}`
              );
        const harness = await testHarness(module.register);
        const testModule = await import(
          /* @vite-ignore */ `${pathToFileURL(resolve(directory, 'tests', filename)).href}?test=${randomUUID()}`
        );
        if (typeof testModule.test !== 'function')
          throw new Error('Test module must export test(harness)');
        await testModule.test(harness);
        stdout.write(`PASS ${filename}\n`);
      } catch (error) {
        failures++;
        stderr.write(
          `FAIL ${filename}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    return failures ? 1 : 0;
  } catch (error) {
    stderr.write(`Mod test failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await host.shutdown();
  }
}

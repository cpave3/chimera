import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadCommands } from '@chimera/commands';
import type { ModBundle } from '@chimera/core';
import { loadModes } from '@chimera/modes';
import { ModHost, type ModRecord } from '@chimera/mods';
import { loadSkills } from '@chimera/skills';
import { loadAgents } from '@chimera/subagents';
import { z } from 'zod';
import declarations from '../../../mod-api/dist/declarations.json';

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


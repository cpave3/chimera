import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_HOOK_EVENTS } from '@chimera/hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHooksList } from '../src/commands/hooks';

describe('runHooksList', () => {
  let cwd: string;
  let writes: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'chimera-hooks-cli-'));
    writes = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      writes.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(cwd, { recursive: true, force: true });
  });

  function output(): string {
    return writes.join('');
  }

  it('lists installed project hook and shows empty sections for unused events', async () => {
    const dir = join(cwd, '.chimera', 'hooks', 'PostToolUse');
    await mkdir(dir, { recursive: true });
    const script = join(dir, 'audit.sh');
    await writeFile(script, '#!/bin/sh\nexit 0\n');
    await chmod(script, 0o755);

    await runHooksList({ cwd });

    const out = output();
    expect(out).toContain('PostToolUse');
    expect(out).toContain(`project  ${script}`);
    // Every defined event must appear in the output, even when empty.
    for (const event of ALL_HOOK_EVENTS) {
      expect(out).toContain(event);
    }
    expect(out).toContain('(none)');
  });

  it('emits a single JSON object on --json with every event present', async () => {
    const dir = join(cwd, '.chimera', 'hooks', 'PostToolUse');
    await mkdir(dir, { recursive: true });
    const script = join(dir, 'audit.sh');
    await writeFile(script, '#!/bin/sh\nexit 0\n');
    await chmod(script, 0o755);

    await runHooksList({ cwd, json: true });

    const out = output().trim();
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('events');
    for (const event of ALL_HOOK_EVENTS) {
      expect(parsed.events).toHaveProperty(event);
      expect(parsed.events[event]).toEqual(
        expect.objectContaining({ global: expect.any(Array), project: expect.any(Array) }),
      );
    }
    expect(parsed.events.PostToolUse.project).toEqual([script]);
  });
});

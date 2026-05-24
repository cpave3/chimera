import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultHookRunner, NoopHookRunner } from '../src/runner';

describe('DefaultHookRunner', () => {
  let root: string;
  let globalRoot: string;
  let projectRoot: string;
  let cwd: string;
  const sessionId = '01J0HK0EJ0AAAAAAAAAAAAAAAA';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chimera-hooks-run-'));
    globalRoot = join(root, 'global');
    projectRoot = join(root, 'project');
    cwd = join(root, 'cwd');
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  async function dropScript(event: string, name: string, body: string): Promise<string> {
    const dir = join(projectRoot, event);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, body);
    await chmod(path, 0o755);
    return path;
  }

  function newRunner(timeoutMs = 5_000): DefaultHookRunner {
    return new DefaultHookRunner({
      cwd,
      sessionId,
      globalRoot,
      projectRoot,
      timeoutMs,
      log: () => {}, // silent
    });
  }

  it('returns blocked: false when no hooks are installed', async () => {
    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.blocked).toBe(false);
  });

  it('passes a JSON payload on stdin and the right env vars', async () => {
    const captured = join(root, 'captured.json');
    const envOut = join(root, 'env.txt');
    await dropScript(
      'PostToolUse',
      'capture.sh',
      `#!/bin/sh
cat > ${JSON.stringify(captured)}
{
  echo "CHIMERA_EVENT=$CHIMERA_EVENT"
  echo "CHIMERA_SESSION_ID=$CHIMERA_SESSION_ID"
  echo "CHIMERA_CWD=$CHIMERA_CWD"
  echo "PWD=$PWD"
} > ${JSON.stringify(envOut)}
exit 0
`,
    );

    await newRunner().fire({
      event: 'PostToolUse',
      tool_name: 'bash',
      tool_input: { command: 'echo hi' },
      tool_result: { stdout: 'hi', exitCode: 0 },
    });

    const stdinBody = await readFile(captured, 'utf8');
    const parsed = JSON.parse(stdinBody);
    expect(parsed).toMatchObject({
      event: 'PostToolUse',
      session_id: sessionId,
      cwd,
      tool_name: 'bash',
      tool_input: { command: 'echo hi' },
      tool_result: { stdout: 'hi', exitCode: 0 },
    });

    const envBody = await readFile(envOut, 'utf8');
    expect(envBody).toContain(`CHIMERA_EVENT=PostToolUse`);
    expect(envBody).toContain(`CHIMERA_SESSION_ID=${sessionId}`);
    expect(envBody).toContain(`CHIMERA_CWD=${cwd}`);
    expect(envBody).toContain(`PWD=${cwd}`);
  });

  it('reports blocked when a pre-event hook exits with code 2', async () => {
    await dropScript(
      'PermissionRequest',
      'block.sh',
      `#!/bin/sh
echo "no rm in this project" >&2
exit 2
`,
    );

    const r = await newRunner().fire({
      event: 'PermissionRequest',
      tool_name: 'bash',
      tool_input: { command: 'rm -rf /' },
      target: 'host',
      command: 'rm -rf /',
    });

    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('no rm in this project');
    expect(r.blockingScript).toContain('block.sh');
  });

  it('does not block on pre-event exit 1 (fail-open)', async () => {
    await dropScript(
      'PermissionRequest',
      'broken.sh',
      `#!/bin/sh
echo "oops" >&2
exit 1
`,
    );

    const r = await newRunner().fire({
      event: 'PermissionRequest',
      tool_name: 'bash',
      tool_input: { command: 'echo hi' },
      target: 'host',
    });
    expect(r.blocked).toBe(false);
  });

  it('does not block when pre-event hook times out', async () => {
    await dropScript(
      'PermissionRequest',
      'hang.sh',
      `#!/bin/sh
sleep 5
exit 0
`,
    );

    const r = await new DefaultHookRunner({
      cwd,
      sessionId,
      globalRoot,
      projectRoot,
      timeoutMs: 200,
      log: () => {},
    }).fire({
      event: 'PermissionRequest',
      tool_name: 'bash',
      tool_input: {},
      target: 'host',
    });
    expect(r.blocked).toBe(false);
  });

  it('does not block when pre-event hook fails to spawn (missing interpreter)', async () => {
    await dropScript(
      'PermissionRequest',
      'no-interp.sh',
      `#!/this/interpreter/does/not/exist
echo nope
`,
    );

    const r = await newRunner().fire({
      event: 'PermissionRequest',
      tool_name: 'bash',
      tool_input: {},
      target: 'host',
    });
    expect(r.blocked).toBe(false);
  });

  it('post-event hooks never block, regardless of exit code', async () => {
    await dropScript(
      'PostToolUse',
      'angry.sh',
      `#!/bin/sh
exit 2
`,
    );

    const r = await newRunner().fire({
      event: 'PostToolUse',
      tool_name: 'bash',
      tool_input: {},
      tool_result: 'ok',
    });
    expect(r.blocked).toBe(false);
  });

  it('runs all matching scripts even after one blocks (per spec)', async () => {
    const counterFile = join(root, 'counter.txt');
    await writeFile(counterFile, '');
    await dropScript(
      'PermissionRequest',
      '01-block.sh',
      `#!/bin/sh
echo "blocked" >&2
exit 2
`,
    );
    await dropScript(
      'PermissionRequest',
      '02-also-runs.sh',
      `#!/bin/sh
echo ran >> ${JSON.stringify(counterFile)}
exit 0
`,
    );

    const r = await newRunner().fire({
      event: 'PermissionRequest',
      tool_name: 'bash',
      tool_input: {},
      target: 'host',
    });
    expect(r.blocked).toBe(true);
    expect(r.blockingScript).toContain('01-block.sh');
    const c = await readFile(counterFile, 'utf8');
    expect(c.trim()).toBe('ran');
  });

  it('discovers scripts dropped between firings (no caching)', async () => {
    const counter = join(root, 'counter.txt');
    await writeFile(counter, '');
    const runner = newRunner();

    // First fire: no hooks installed. Should be a no-op.
    const first = await runner.fire({ event: 'Stop', reason: 'stop' });
    expect(first.blocked).toBe(false);
    let body = await readFile(counter, 'utf8');
    expect(body).toBe('');

    // Drop a script and fire again. The runner must rediscover.
    await dropScript(
      'Stop',
      'count.sh',
      `#!/bin/sh
echo ran >> ${JSON.stringify(counter)}
exit 0
`,
    );
    const second = await runner.fire({ event: 'Stop', reason: 'stop' });
    expect(second.blocked).toBe(false);
    body = await readFile(counter, 'utf8');
    expect(body.trim()).toBe('ran');
  });

  it('blocks via JSON decision on exit 0 with decision="block"', async () => {
    await dropScript(
      'Stop',
      'json-block.sh',
      `#!/bin/sh
echo '{"decision":"block","reason":"stop rejected"}'
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('stop rejected');
    expect(r.parsedDecision).toMatchObject({ decision: 'block', reason: 'stop rejected' });
  });

  it('allows when exit 0 JSON does not contain decision="block"', async () => {
    await dropScript(
      'Stop',
      'json-info.sh',
      `#!/bin/sh
echo '{"additionalContext":"lint passed"}'
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.blocked).toBe(false);
    expect(r.parsedDecision?.additionalContext).toBe('lint passed');
  });

  it('allows when exit 0 stdout is empty', async () => {
    await dropScript(
      'Stop',
      'silent.sh',
      `#!/bin/sh
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.blocked).toBe(false);
    expect(r.parsedDecision).toBeUndefined();
  });

  it('allows when exit 0 stdout is non-JSON text', async () => {
    await dropScript(
      'Stop',
      'chatty.sh',
      `#!/bin/sh
echo "lint complete"
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.blocked).toBe(false);
    expect(r.parsedDecision).toBeUndefined();
  });

  it('parses hookSpecificOutput for Claude compat', async () => {
    await dropScript(
      'Stop',
      'claude-compat.sh',
      `#!/bin/sh
echo '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"remember to test"}}'
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.blocked).toBe(false);
    expect(r.parsedDecision?.additionalContext).toBe('remember to test');
    expect(r.parsedDecision?.hookSpecificOutput).toBeDefined();
  });

  it('top-level fields take precedence over hookSpecificOutput', async () => {
    await dropScript(
      'Stop',
      'precedence.sh',
      `#!/bin/sh
echo '{"hookSpecificOutput":{"reason":"inner"},"reason":"outer"}'
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.parsedDecision?.reason).toBe('outer');
  });

  it('caps large string output at 10,000 chars', async () => {
    await dropScript(
      'Stop',
      'huge.sh',
      `#!/bin/sh
python3 -c "import json; print(json.dumps({'additionalContext':'x'*20000}))"
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.parsedDecision?.additionalContext?.length).toBe(10_000);
  });

  it('allows when spawn fails, even if JSON would have blocked', async () => {
    await dropScript(
      'Stop',
      'bad-interpreter.sh',
      `#!/does/not/exist
echo '{"decision":"block"}'
exit 0
`,
    );

    const r = await newRunner().fire({ event: 'Stop', reason: 'stop' });
    // Spawn failure = logged, not blocked
    expect(r.blocked).toBe(false);
  });

});

describe('NoopHookRunner', () => {
  it('always returns blocked: false', async () => {
    const r = await new NoopHookRunner().fire({ event: 'Stop', reason: 'stop' });
    expect(r.blocked).toBe(false);
  });
});

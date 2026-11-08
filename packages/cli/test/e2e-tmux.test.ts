import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Runs the built CLI inside a private tmux server (`tmux -L`, no config
// file), so the user's own server and options are never touched.
// Gated: CHIMERA_TEST_TMUX=1 and tmux on the PATH.

const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js');
const FAKE_SERVER = join(import.meta.dirname, 'fixtures', 'fake-model-server.mjs');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const enabled = process.env.CHIMERA_TEST_TMUX === '1' && hasTmux && existsSync(BIN);
const SOCKET = `chimera-test-${process.pid}`;
const SESSION = 'chimera';

function tmux(...args: string[]): string {
  const result = spawnSync('tmux', ['-L', SOCKET, '-f', '/dev/null', ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`tmux ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** The visible pane, or with `history` everything in the pane's scrollback too. */
function capture(history = false): string[] {
  return tmux('capture-pane', '-p', '-t', SESSION, ...(history ? ['-S', '-'] : [])).split('\n');
}

async function until(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${what}; the pane shows:\n${capture(true).join('\n')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const shows = (text: string, history = false) => capture(history).some((row) => row.includes(text));

describe.skipIf(!enabled)('the TUI in tmux', { timeout: 40_000 }, () => {
  let home: string;
  let server: ChildProcess;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'chimera-tmux-'));
    await mkdir(join(home, '.chimera'), { recursive: true });
    await mkdir(join(home, 'work'));
    const script = [{ text: `Answer to {last}: ${'words '.repeat(12).trim()}.`, repeat: true }];
    await writeFile(join(home, 'script.json'), JSON.stringify(script));
    server = spawn(process.execPath, [FAKE_SERVER, join(home, 'script.json'), '0']);
    const port = await new Promise<number>((resolve) => {
      server.stdout!.on('data', (chunk: Buffer) => {
        const match = /listening (\d+)/.exec(chunk.toString());
        if (match) resolve(Number(match[1]));
      });
    });
    await writeFile(
      join(home, '.chimera', 'config.json'),
      JSON.stringify({
        providers: {
          fake: { shape: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'x' },
        },
        defaultModel: 'fake/model',
        models: { 'fake/model': { contextWindow: 100_000 } },
        workspaceCheckpoints: false,
        tui: { notifications: 'off' },
      }),
    );
  });

  afterAll(async () => {
    server?.kill();
    await rm(home, { recursive: true, force: true });
  });

  afterEach(() => {
    spawnSync('tmux', ['-L', SOCKET, 'kill-server']);
  });

  /** Start chimera in a fresh private server; the pane stays open after it exits. */
  async function start(options: { inline?: boolean; setup?: string[][] } = {}): Promise<void> {
    const command = [
      // The options below are set before chimera starts and asks for its modes.
      'sleep 0.3;',
      `HOME='${home}'`,
      'TERM=tmux-256color',
      `'${process.execPath}'`,
      `'${BIN}'`,
      ...(options.inline ? ['--inline'] : []),
      '; sleep 60',
    ].join(' ');
    tmux(
      'new-session',
      '-d',
      '-s',
      SESSION,
      '-x',
      '100',
      '-y',
      '30',
      '-c',
      join(home, 'work'),
      command,
    );
    for (const option of options.setup ?? []) tmux(...option);
    await until(() => shows('╭─ build'), 'the prompt box');
  }

  async function say(text: string): Promise<void> {
    tmux('send-keys', '-t', SESSION, '-l', text);
    tmux('send-keys', '-t', SESSION, 'Enter');
    await until(() => shows(`Answer to ${text}:`), `the answer to ${text}`);
    await until(() => shows('? help'), 'the run to end');
  }

  function resize(columns: number): void {
    tmux('resize-window', '-t', SESSION, '-x', String(columns), '-y', '30');
  }

  it('lays out the fullscreen layout again on a resize, with no stale rows', async () => {
    await start();
    await say('first message');
    resize(60);
    await until(() => capture().every((row) => row.length <= 60), 'the narrow layout');
    resize(100);
    await until(() => shows('╰─') && capture().some((row) => row.length > 60), 'the wide layout');
    const rows = capture();
    expect(rows.filter((row) => row.includes('you  first message'))).toHaveLength(1);
    expect(rows.filter((row) => row.startsWith('╭─ build'))).toHaveLength(1);
  });

  it('reprints the inline layout once on a resize, without duplicated history', async () => {
    await start({ inline: true });
    await say('inline message');
    resize(60);
    await until(
      () =>
        capture().filter((row) => row.startsWith('╭─')).length === 1 &&
        capture().every((row) => row.length <= 60),
      'the narrow reprint',
    );
    resize(100);
    await until(
      () => capture(true).some((row) => row.length > 60 && row.startsWith('╰─')),
      'the wide reprint',
    );
    const history = capture(true);
    expect(history.filter((row) => row.includes('you  inline message'))).toHaveLength(1);
    expect(history.filter((row) => row.startsWith('╭─ build'))).toHaveLength(1);
  });

  it('leaves the transcript and the resume line in the history after quitting fullscreen', async () => {
    await start();
    await say('remember me');
    tmux('send-keys', '-t', SESSION, 'C-c');
    tmux('send-keys', '-t', SESSION, 'C-c');
    await until(() => shows('resume with: chimera --session', true), 'the resume line');
    const history = capture(true);
    expect(history.some((row) => row.includes('    you  remember me'))).toBe(true);
    expect(history.some((row) => row.startsWith('╭─'))).toBe(false);
  });

  it('inserts a newline for Shift+Enter with extended keys on', async () => {
    await start({ setup: [['set', '-s', 'extended-keys', 'on']] });
    tmux('send-keys', '-t', SESSION, '-l', 'first');
    tmux('send-keys', '-t', SESSION, 'S-Enter');
    tmux('send-keys', '-t', SESSION, '-l', 'second');
    await until(() => shows('│   second'), 'the second line in the prompt box');
    expect(shows('│ › first')).toBe(true);
  });

  it('scrolls the transcript with the wheel and copies a drag with mouse on', async () => {
    await start({
      setup: [
        ['set', '-g', 'mouse', 'on'],
        ['set', '-s', 'set-clipboard', 'on'],
      ],
    });
    for (let index = 0; index < 10; index += 1) await say(`message ${index}`);
    expect(shows('message 9')).toBe(true);
    // A terminal's SGR mouse reports, as tmux passes them on to the pane.
    for (let notch = 0; notch < 8; notch += 1)
      tmux('send-keys', '-t', SESSION, '-l', '\x1b[<64;20;5M');
    await until(() => !shows('message 9'), 'the transcript to scroll up');
    for (let notch = 0; notch < 20; notch += 1)
      tmux('send-keys', '-t', SESSION, '-l', '\x1b[<65;20;5M');
    await until(() => shows('message 9'), 'the transcript to scroll back');
    const row = capture().findIndex((line) => line.includes('you  message 9'));
    const press = `\x1b[<0;10;${row + 1}M`;
    const drag = `\x1b[<32;25;${row + 1}M`;
    const release = `\x1b[<0;25;${row + 1}m`;
    tmux('send-keys', '-t', SESSION, '-l', press + drag + release);
    await until(() => shows('copied'), 'the copy notice');
    expect(tmux('show-buffer')).toContain('message 9');
  });

  it('keeps the line breaks of a bracketed paste from paste-buffer', async () => {
    await start();
    tmux('set-buffer', 'pasted line one\npasted line two');
    tmux('paste-buffer', '-p', '-t', SESSION);
    await until(() => shows('│   pasted line two'), 'the pasted second line');
    expect(shows('│ › pasted line one')).toBe(true);
  });
});

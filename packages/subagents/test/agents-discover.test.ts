import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover } from '../src/agents/discover';
import { parseToolsCsv } from '../src/agents/frontmatter';
import { loadAgents } from '../src/agents/load';

let cwd: string;
let userHome: string;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'chimera-agents-discover-'));
  cwd = join(root, 'project');
  userHome = join(root, 'home');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(userHome, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
});

function writeAgent(
  dir: string,
  name: string,
  frontmatter: string,
  body = 'system prompt body',
): string {
  const target = join(dir, `${name}.md`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, `---\n${frontmatter}---\n${body}`);
  return target;
}

/** What the user's own directories hold; the bundled definitions have their own tests below. */
function discoverOwn(options: Parameters<typeof discover>[0]) {
  const result = discover(options);
  return { ...result, agents: result.agents.filter((agent) => agent.source !== 'builtin') };
}

describe('agents discover', () => {
  it('loads mod agents below native tiers and above compatibility tiers', () => {
    const directory = join(userHome, 'bundle');
    const frontmatter = 'name: audit\ndescription: Audit code\n';
    writeAgent(join(directory, 'reviewers'), 'audit', frontmatter);
    writeAgent(join(cwd, '.claude/agents'), 'audit', frontmatter);
    const modBundles = [
      { name: 'first', directory, manifest: { agents: 'reviewers' } },
      { name: 'second', directory, manifest: { agents: 'reviewers' } },
    ];
    const registry = loadAgents({ cwd, userHome, modBundles });
    expect(registry.find('audit')).toMatchObject({
      source: 'mod:first',
      body: 'system prompt body',
    });
    expect(registry.collisions().map((collision) => collision.loser)).toEqual([
      'mod:second',
      'claude-project',
    ]);
    writeAgent(join(userHome, '.chimera/agents'), 'audit', frontmatter);
    expect(loadAgents({ cwd, userHome, modBundles }).find('audit')?.source).toBe('user');
  });

  it('discovers agents from project/.chimera/agents and parses frontmatter', () => {
    const dir = join(cwd, '.chimera', 'agents');
    writeAgent(
      dir,
      'review-correctness',
      'name: review-correctness\ndescription: Logical correctness pass\ntools: Read, Grep, Glob\nmodel: sonnet\n',
      'You are a correctness reviewer. Check the diff.',
    );

    const result = discoverOwn({ cwd, userHome });
    expect(result.agents).toHaveLength(1);
    const [agent] = result.agents;
    expect(agent.name).toBe('review-correctness');
    expect(agent.description).toBe('Logical correctness pass');
    expect(agent.source).toBe('project');
    expect(agent.body).toBe('You are a correctness reviewer. Check the diff.');
    expect(agent.frontmatter['tools']).toBe('Read, Grep, Glob');
    expect(agent.frontmatter['model']).toBe('sonnet');
  });

  it('honors six-tier precedence: project > user > claude-project > claude-user', () => {
    writeAgent(
      join(cwd, '.chimera', 'agents'),
      'reviewer',
      'name: reviewer\ndescription: from project\n',
    );
    writeAgent(
      join(userHome, '.chimera', 'agents'),
      'reviewer',
      'name: reviewer\ndescription: from user\n',
    );
    writeAgent(
      join(cwd, '.claude', 'agents'),
      'reviewer',
      'name: reviewer\ndescription: from claude-project\n',
    );
    writeAgent(
      join(userHome, '.claude', 'agents'),
      'reviewer',
      'name: reviewer\ndescription: from claude-user\n',
    );

    const result = discoverOwn({ cwd, userHome });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].source).toBe('project');
    expect(result.agents[0].description).toBe('from project');
    // 3 collisions, all losing to project
    expect(result.collisions).toHaveLength(3);
    expect(result.collisions.every((c) => c.winner === 'project')).toBe(true);
  });

  it('falls back to filename when frontmatter has no name field', () => {
    writeAgent(join(cwd, '.chimera', 'agents'), 'tidy-up', 'description: implicit name\n');
    const result = discoverOwn({ cwd, userHome });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe('tidy-up');
  });

  it('skips files where frontmatter name disagrees with filename', () => {
    writeAgent(
      join(cwd, '.chimera', 'agents'),
      'reviewer',
      'name: not-reviewer\ndescription: oops\n',
    );
    const warnings: string[] = [];
    const result = discoverOwn({ cwd, userHome, onWarning: (m) => warnings.push(m) });
    expect(result.agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes('does not match filename'))).toBe(true);
  });

  it('skips files missing a description', () => {
    writeAgent(join(cwd, '.chimera', 'agents'), 'noop', 'name: noop\n');
    const warnings: string[] = [];
    const result = discoverOwn({ cwd, userHome, onWarning: (m) => warnings.push(m) });
    expect(result.agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes('description'))).toBe(true);
  });

  it('skips claude tiers when includeClaudeCompat is false', () => {
    writeAgent(
      join(userHome, '.claude', 'agents'),
      'reviewer',
      'name: reviewer\ndescription: claude only\n',
    );
    const result = discoverOwn({ cwd, userHome, includeClaudeCompat: false });
    expect(result.agents).toHaveLength(0);
  });

  it('ignores non-.md files', () => {
    const dir = join(cwd, '.chimera', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), '---\nname: notes\ndescription: x\n---\n');
    const result = discoverOwn({ cwd, userHome });
    expect(result.agents).toHaveLength(0);
  });
});

describe('parseToolsCsv', () => {
  it('lowercases, trims, and dedupes', () => {
    expect(parseToolsCsv('Read, Grep, GLOB,read')).toEqual(['read', 'grep', 'glob']);
  });

  it('returns [] for empty / undefined input', () => {
    expect(parseToolsCsv(undefined)).toEqual([]);
    expect(parseToolsCsv('')).toEqual([]);
    expect(parseToolsCsv(',, ,')).toEqual([]);
  });
});

describe('built-in agents', () => {
  it('offers explore with no setup, as a read-only agent on the utility model', () => {
    const { agents } = discover({ cwd, userHome });
    const explore = agents.find((agent) => agent.name === 'explore');

    expect(explore?.source).toBe('builtin');
    // From the code: a single binary has no agents directory on disk.
    expect(explore?.path).not.toContain(join('packages', 'subagents'));
    expect(parseToolsCsv(explore?.frontmatter.tools)).toEqual([
      'read',
      'glob',
      'grep',
      'fetch',
      'web_search',
    ]);
    expect(explore?.frontmatter.model).toBe('utility');
    expect(explore?.body).toMatch(/path:line/);
  });

  it('gives way to a user definition of the same name, without a warning', () => {
    writeAgent(
      join(userHome, '.chimera', 'agents'),
      'explore',
      'name: explore\ndescription: My own search helper\n',
      'Search my way.',
    );
    const warnings: string[] = [];

    const { agents } = discover({ cwd, userHome, onWarning: (message) => warnings.push(message) });
    const explore = agents.find((agent) => agent.name === 'explore');

    expect(explore?.source).toBe('user');
    expect(explore?.body).toBe('Search my way.');
    expect(warnings).toEqual([]);
  });
});

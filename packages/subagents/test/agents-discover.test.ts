import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover } from '../src/agents/discover';
import { parseToolsCsv } from '../src/agents/frontmatter';

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

describe('agents discover', () => {
  it('discovers agents from project/.chimera/agents and parses frontmatter', () => {
    const dir = join(cwd, '.chimera', 'agents');
    writeAgent(
      dir,
      'review-correctness',
      'name: review-correctness\ndescription: Logical correctness pass\ntools: Read, Grep, Glob\nmodel: sonnet\n',
      'You are a correctness reviewer. Check the diff.',
    );

    const result = discover({ cwd, userHome });
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

    const result = discover({ cwd, userHome });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].source).toBe('project');
    expect(result.agents[0].description).toBe('from project');
    // 3 collisions, all losing to project
    expect(result.collisions).toHaveLength(3);
    expect(result.collisions.every((c) => c.winner === 'project')).toBe(true);
  });

  it('falls back to filename when frontmatter has no name field', () => {
    writeAgent(join(cwd, '.chimera', 'agents'), 'tidy-up', 'description: implicit name\n');
    const result = discover({ cwd, userHome });
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
    const result = discover({ cwd, userHome, onWarning: (m) => warnings.push(m) });
    expect(result.agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes('does not match filename'))).toBe(true);
  });

  it('skips files missing a description', () => {
    writeAgent(join(cwd, '.chimera', 'agents'), 'noop', 'name: noop\n');
    const warnings: string[] = [];
    const result = discover({ cwd, userHome, onWarning: (m) => warnings.push(m) });
    expect(result.agents).toHaveLength(0);
    expect(warnings.some((w) => w.includes('description'))).toBe(true);
  });

  it('skips claude tiers when includeClaudeCompat is false', () => {
    writeAgent(
      join(userHome, '.claude', 'agents'),
      'reviewer',
      'name: reviewer\ndescription: claude only\n',
    );
    const result = discover({ cwd, userHome, includeClaudeCompat: false });
    expect(result.agents).toHaveLength(0);
  });

  it('ignores non-.md files', () => {
    const dir = join(cwd, '.chimera', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), '---\nname: notes\ndescription: x\n---\n');
    const result = discover({ cwd, userHome });
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

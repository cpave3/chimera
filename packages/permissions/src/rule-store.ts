import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PermissionRule } from '@chimera/core';
import type { StoredRulesFile } from './types';

const FILE_VERSION = 1 as const;

export class RuleStore {
  private sessionRules: PermissionRule[] = [];
  private projectRules: PermissionRule[] = [];
  private globalRules: PermissionRule[] = [];
  private readonly projectPath: string;
  private readonly globalPath: string;

  constructor(cwd: string, home = homedir()) {
    this.projectPath = join(cwd, '.chimera', 'permissions.json');
    this.globalPath = join(home, '.chimera', 'permissions.json');
    this.projectRules = this.load(this.projectPath);
    this.globalRules = this.load(this.globalPath);
  }

  private load(path: string): PermissionRule[] {
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredRulesFile;
      if (parsed.version === FILE_VERSION && Array.isArray(parsed.rules)) return parsed.rules;
      console.warn(`[rule-store] invalid rules file: ${path}`);
    } catch (err) {
      console.warn(
        `[rule-store] failed to parse ${path}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return [];
  }

  private persist(path: string, rules: PermissionRule[], global: boolean): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, ...(global ? { mode: 0o700 } : {}) });
    const data: StoredRulesFile = { version: FILE_VERSION, rules };
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), global ? { mode: 0o600 } : 'utf8');
    renameSync(tmp, path);
  }

  add(rule: PermissionRule, scope: 'session' | 'project' | 'global'): void {
    if (scope === 'session') {
      this.sessionRules.push(rule);
    } else if (scope === 'project') {
      this.projectRules.push(rule);
      this.persist(this.projectPath, this.projectRules, false);
    } else {
      this.globalRules.push(rule);
      this.persist(this.globalPath, this.globalRules, true);
    }
  }

  all(): PermissionRule[] {
    return [...this.sessionRules, ...this.projectRules, ...this.globalRules];
  }

  /** Remove by index in the `all()` ordering. */
  removeAt(index: number): void {
    const total = this.sessionRules.length + this.projectRules.length + this.globalRules.length;
    if (index < 0 || index >= total) {
      throw new Error(`Rule index out of range: ${index}`);
    }
    if (index < this.sessionRules.length) {
      this.sessionRules.splice(index, 1);
      return;
    }
    const projectIndex = index - this.sessionRules.length;
    if (projectIndex < this.projectRules.length) {
      this.projectRules.splice(projectIndex, 1);
      this.persist(this.projectPath, this.projectRules, false);
      return;
    }
    this.globalRules.splice(projectIndex - this.projectRules.length, 1);
    this.persist(this.globalPath, this.globalRules, true);
  }

  session(): PermissionRule[] {
    return [...this.sessionRules];
  }

  project(): PermissionRule[] {
    return [...this.projectRules];
  }

  projectPathFor(): string {
    return this.projectPath;
  }
}

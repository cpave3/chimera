import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PermissionRule } from '@chimera/core';
import type { StoredRulesFile } from './types';

const FILE_VERSION = 1 as const;

export class RuleStore {
  private sessionRules: PermissionRule[] = [];
  private projectRules: PermissionRule[] = [];
  private readonly projectPath: string;

  constructor(cwd: string) {
    this.projectPath = join(cwd, '.chimera', 'permissions.json');
    this.loadProject();
  }

  private loadProject(): void {
    if (!existsSync(this.projectPath)) return;
    try {
      const raw = readFileSync(this.projectPath, 'utf8');
      const parsed = JSON.parse(raw) as StoredRulesFile;
      if (parsed.version === FILE_VERSION && Array.isArray(parsed.rules)) {
        this.projectRules = parsed.rules;
      }
    } catch {
      // leave projectRules empty on parse error
    }
  }

  private persistProject(): void {
    const dir = dirname(this.projectPath);
    mkdirSync(dir, { recursive: true });
    const data: StoredRulesFile = { version: FILE_VERSION, rules: this.projectRules };
    const tmp = `${this.projectPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, this.projectPath);
  }

  add(rule: PermissionRule, scope: 'session' | 'project'): void {
    if (scope === 'session') {
      this.sessionRules.push(rule);
    } else {
      this.projectRules.push(rule);
      this.persistProject();
    }
  }

  all(): PermissionRule[] {
    return [...this.sessionRules, ...this.projectRules];
  }

  /**
   * Remove by index in the `all()` ordering. Persists project changes.
   */
  removeAt(index: number): void {
    const total = this.sessionRules.length + this.projectRules.length;
    if (index < 0 || index >= total) {
      throw new Error(`Rule index out of range: ${index}`);
    }
    if (index < this.sessionRules.length) {
      this.sessionRules.splice(index, 1);
      return;
    }
    this.projectRules.splice(index - this.sessionRules.length, 1);
    this.persistProject();
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

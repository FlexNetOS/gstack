// Ark Home — Permission Model
// YAML config defining which resource actions are allowed per context.
// Default: read-only. Destructive operations require explicit opt-in.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Context } from './types';

export interface PermissionRule {
  provider: string;
  action: string;
  allowed: boolean;
}

export interface PermissionConfig {
  /** Default policy: 'read-only' or 'allow-all' */
  defaultPolicy: 'read-only' | 'allow-all';
  /** Per-context overrides */
  contexts: Partial<Record<Context, PermissionRule[]>>;
  /** Global rules (apply to all contexts) */
  global: PermissionRule[];
}

const DEFAULT_PERMISSIONS: PermissionConfig = {
  defaultPolicy: 'read-only',
  contexts: {},
  global: [],
};

export class PermissionManager {
  private config: PermissionConfig;
  private configPath: string;

  constructor(configDir?: string) {
    const dir = configDir || join(process.env.HOME || '/root', '.ark-home');
    this.configPath = join(dir, 'permissions.yaml');
    this.config = this.load();
  }

  /** Check if an action is permitted for a given context. */
  check(provider: string, action: string, context: Context, destructive: boolean): { permitted: boolean; reason: string } {
    // 1. Check global explicit rules
    const globalRule = this.config.global.find(r => r.provider === provider && r.action === action);
    if (globalRule) {
      return globalRule.allowed
        ? { permitted: true, reason: 'allowed by global rule' }
        : { permitted: false, reason: `blocked by global rule: ${provider}.${action}` };
    }

    // 2. Check context-specific rules
    const contextRules = this.config.contexts[context] || [];
    const contextRule = contextRules.find(r => r.provider === provider && r.action === action);
    if (contextRule) {
      return contextRule.allowed
        ? { permitted: true, reason: `allowed by ${context} context rule` }
        : { permitted: false, reason: `blocked by ${context} context rule: ${provider}.${action}` };
    }

    // 3. Apply default policy
    if (this.config.defaultPolicy === 'allow-all') {
      return { permitted: true, reason: 'default policy: allow-all' };
    }

    // read-only: allow non-destructive, block destructive
    if (destructive) {
      return {
        permitted: false,
        reason: `default policy: read-only (${provider}.${action} is destructive)`,
      };
    }
    return { permitted: true, reason: 'default policy: read-only (non-destructive)' };
  }

  /** Get current config. */
  getConfig(): PermissionConfig {
    return { ...this.config };
  }

  /** Add a global rule. */
  addGlobalRule(rule: PermissionRule): void {
    this.config.global = this.config.global.filter(
      r => !(r.provider === rule.provider && r.action === rule.action),
    );
    this.config.global.push(rule);
    this.save();
  }

  /** Add a context-specific rule. */
  addContextRule(context: Context, rule: PermissionRule): void {
    if (!this.config.contexts[context]) {
      this.config.contexts[context] = [];
    }
    const rules = this.config.contexts[context]!;
    const idx = rules.findIndex(r => r.provider === rule.provider && r.action === rule.action);
    if (idx >= 0) rules[idx] = rule;
    else rules.push(rule);
    this.save();
  }

  // --- Persistence (simple JSON, not YAML to avoid dependency) ---

  private load(): PermissionConfig {
    try {
      if (existsSync(this.configPath)) {
        const raw = readFileSync(this.configPath, 'utf-8');
        return { ...DEFAULT_PERMISSIONS, ...JSON.parse(raw) };
      }
    } catch {
      // Corrupt or missing config — use defaults
    }
    return { ...DEFAULT_PERMISSIONS };
  }

  private save(): void {
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ark-home] Permission config save failed:', err);
    }
  }
}

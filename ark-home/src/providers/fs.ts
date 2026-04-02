// Ark Home — Filesystem Resource Provider
// Read, write, list, and watch files within allowed directories.

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import type { ResourceProvider, ProviderAction, ProviderHealth } from './index';

export interface FsProviderConfig {
  /** Root directories the provider can access. Default: [HOME] */
  roots: string[];
  /** Max file size to read (bytes). Default: 10MB */
  maxReadSize: number;
  /** Allow write operations. Default: false (read-only) */
  allowWrite: boolean;
}

const DEFAULT_FS_CONFIG: FsProviderConfig = {
  roots: [process.env.HOME || '/home'],
  maxReadSize: 10 * 1024 * 1024,
  allowWrite: false,
};

export class FsProvider implements ResourceProvider {
  readonly name = 'fs';
  readonly description = 'Filesystem: read, list, and optionally write files';
  private config: FsProviderConfig;

  constructor(config?: Partial<FsProviderConfig>) {
    this.config = { ...DEFAULT_FS_CONFIG, ...config };
  }

  async init(): Promise<boolean> {
    // Verify at least one root exists
    return this.config.roots.some(r => existsSync(r));
  }

  actions(): ProviderAction[] {
    const acts: ProviderAction[] = [
      { name: 'list', description: 'List files in a directory', destructive: false },
      { name: 'read', description: 'Read a file', destructive: false },
      { name: 'stat', description: 'Get file/directory info', destructive: false },
      { name: 'search', description: 'Search for files by name pattern', destructive: false },
    ];
    if (this.config.allowWrite) {
      acts.push(
        { name: 'write', description: 'Write content to a file', destructive: true },
        { name: 'mkdir', description: 'Create a directory', destructive: true },
      );
    }
    return acts;
  }

  async execute(action: string, args: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'list': return this.list(args);
      case 'read': return this.read(args);
      case 'stat': return this.statFile(args);
      case 'search': return this.search(args);
      case 'write': return this.write(args);
      case 'mkdir': return this.mkdirAction(args);
      default: throw new Error(`Unknown fs action: ${action}`);
    }
  }

  async health(): Promise<ProviderHealth> {
    const accessible = this.config.roots.filter(r => existsSync(r));
    return {
      available: accessible.length > 0,
      details: `${accessible.length}/${this.config.roots.length} roots accessible`,
    };
  }

  // --- Actions ---

  private list(args: Record<string, unknown>): { path: string; entries: { name: string; type: string; size: number }[] } {
    const dir = this.resolvePath(String(args.path || '.'));
    if (!existsSync(dir)) throw new Error(`Directory not found: ${args.path}`);

    const entries = readdirSync(dir, { withFileTypes: true }).map(d => {
      let size = 0;
      try { size = d.isFile() ? statSync(join(dir, d.name)).size : 0; } catch { /* skip */ }
      return {
        name: d.name,
        type: d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other',
        size,
      };
    });
    return { path: dir, entries };
  }

  private read(args: Record<string, unknown>): { path: string; content: string; size: number } {
    const filePath = this.resolvePath(String(args.path || ''));
    if (!existsSync(filePath)) throw new Error(`File not found: ${args.path}`);

    const st = statSync(filePath);
    if (st.size > this.config.maxReadSize) {
      throw new Error(`File too large: ${st.size} bytes (max: ${this.config.maxReadSize})`);
    }

    const content = readFileSync(filePath, 'utf-8');
    return { path: filePath, content, size: st.size };
  }

  private statFile(args: Record<string, unknown>): Record<string, unknown> {
    const filePath = this.resolvePath(String(args.path || ''));
    if (!existsSync(filePath)) throw new Error(`Path not found: ${args.path}`);

    const st = statSync(filePath);
    return {
      path: filePath,
      type: st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
      size: st.size,
      modified: st.mtime.toISOString(),
      created: st.birthtime.toISOString(),
    };
  }

  private search(args: Record<string, unknown>): { matches: string[] } {
    const pattern = String(args.pattern || '').toLowerCase();
    const searchRoot = this.resolvePath(String(args.path || '.'));
    if (!pattern) throw new Error('Missing search pattern');

    const matches: string[] = [];
    const maxResults = Number(args.limit) || 20;

    const walk = (dir: string, depth: number) => {
      if (depth > 5 || matches.length >= maxResults) return;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          if (entry.name.toLowerCase().includes(pattern)) {
            matches.push(join(dir, entry.name));
          }
          if (entry.isDirectory() && !entry.name.startsWith('node_modules')) {
            walk(join(dir, entry.name), depth + 1);
          }
        }
      } catch { /* permission denied, skip */ }
    };

    walk(searchRoot, 0);
    return { matches };
  }

  private write(args: Record<string, unknown>): { path: string; written: number } {
    if (!this.config.allowWrite) throw new Error('Write operations not permitted');
    const filePath = this.resolvePath(String(args.path || ''));
    const content = String(args.content || '');
    writeFileSync(filePath, content, 'utf-8');
    return { path: filePath, written: content.length };
  }

  private mkdirAction(args: Record<string, unknown>): { path: string } {
    if (!this.config.allowWrite) throw new Error('Write operations not permitted');
    const dirPath = this.resolvePath(String(args.path || ''));
    mkdirSync(dirPath, { recursive: true });
    return { path: dirPath };
  }

  // --- Security ---

  private resolvePath(input: string): string {
    const resolved = resolve(input);
    const withinRoot = this.config.roots.some(root => {
      const rel = relative(root, resolved);
      return !rel.startsWith('..');
    });
    if (!withinRoot) {
      throw new Error(`Access denied: ${input} is outside allowed roots`);
    }
    return resolved;
  }
}

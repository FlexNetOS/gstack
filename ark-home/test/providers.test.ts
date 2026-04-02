// Ark Home — Resource Provider Tests

import { describe, test, expect, beforeAll } from 'bun:test';
import { ResourceRegistry } from '../src/providers/index';
import { FsProvider } from '../src/providers/fs';
import { NetworkProvider } from '../src/providers/network';
import { PermissionManager } from '../src/permissions';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpDir = mkdtempSync(join(tmpdir(), 'ark-provider-test-'));
mkdirSync(join(tmpDir, 'subdir'), { recursive: true });
writeFileSync(join(tmpDir, 'test.txt'), 'hello provider');
writeFileSync(join(tmpDir, 'subdir', 'nested.txt'), 'nested content');

describe('FsProvider', () => {
  let fs: FsProvider;

  beforeAll(async () => {
    fs = new FsProvider({ roots: [tmpDir], allowWrite: true, maxReadSize: 1024 });
    await fs.init();
  });

  test('list directory', async () => {
    const result = await fs.execute('list', { path: tmpDir }) as { entries: { name: string }[] };
    expect(result.entries.some(e => e.name === 'test.txt')).toBe(true);
    expect(result.entries.some(e => e.name === 'subdir')).toBe(true);
  });

  test('read file', async () => {
    const result = await fs.execute('read', { path: join(tmpDir, 'test.txt') }) as { content: string };
    expect(result.content).toBe('hello provider');
  });

  test('stat file', async () => {
    const result = await fs.execute('stat', { path: join(tmpDir, 'test.txt') }) as { type: string; size: number };
    expect(result.type).toBe('file');
    expect(result.size).toBe(14);
  });

  test('search files', async () => {
    const result = await fs.execute('search', { path: tmpDir, pattern: 'nested' }) as { matches: string[] };
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]).toContain('nested.txt');
  });

  test('write file', async () => {
    const target = join(tmpDir, 'written.txt');
    await fs.execute('write', { path: target, content: 'new content' });
    const result = await fs.execute('read', { path: target }) as { content: string };
    expect(result.content).toBe('new content');
  });

  test('blocks access outside roots', async () => {
    expect(() => fs.execute('read', { path: '/etc/passwd' })).toThrow('Access denied');
  });

  test('health check', async () => {
    const h = await fs.health();
    expect(h.available).toBe(true);
  });
});

describe('NetworkProvider', () => {
  let net: NetworkProvider;

  beforeAll(async () => {
    net = new NetworkProvider();
    await net.init();
  });

  test('list interfaces', async () => {
    const result = await net.execute('interfaces', {}) as { interfaces: { name: string; address: string }[] };
    expect(Array.isArray(result.interfaces)).toBe(true);
  });

  test('check URL', async () => {
    // Check a known-bad URL — should return ok: false, not throw
    const result = await net.execute('check', { url: 'http://localhost:1' }) as { ok: boolean };
    expect(result.ok).toBe(false);
  });

  test('health check', async () => {
    const h = await net.health();
    expect(h.available).toBe(true);
  });
});

describe('ResourceRegistry', () => {
  test('register and list providers', async () => {
    const registry = new ResourceRegistry();
    registry.register(new FsProvider({ roots: [tmpDir], allowWrite: false, maxReadSize: 1024 }));
    await registry.initAll();

    const list = registry.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('fs');
  });

  test('execute through registry', async () => {
    const registry = new ResourceRegistry();
    registry.register(new FsProvider({ roots: [tmpDir], allowWrite: false, maxReadSize: 1024 }));
    await registry.initAll();

    const result = await registry.execute('fs', 'list', { path: tmpDir }) as { entries: unknown[] };
    expect(Array.isArray(result.entries)).toBe(true);
  });

  test('throws on unknown provider', async () => {
    const registry = new ResourceRegistry();
    expect(registry.execute('nope', 'list', {})).rejects.toThrow('Unknown provider');
  });

  test('healthAll returns status for all providers', async () => {
    const registry = new ResourceRegistry();
    registry.register(new FsProvider({ roots: [tmpDir], allowWrite: false, maxReadSize: 1024 }));
    registry.register(new NetworkProvider());
    await registry.initAll();

    const health = await registry.healthAll();
    expect(health.fs).toBeDefined();
    expect(health.fs.available).toBe(true);
    expect(health.network).toBeDefined();
    expect(health.network.available).toBe(true);
  });
});

describe('PermissionManager', () => {
  let perms: PermissionManager;

  beforeAll(() => {
    perms = new PermissionManager(tmpDir);
  });

  test('default policy blocks destructive actions', () => {
    const result = perms.check('docker', 'stop', 'business', true);
    expect(result.permitted).toBe(false);
    expect(result.reason).toContain('read-only');
  });

  test('default policy allows non-destructive actions', () => {
    const result = perms.check('fs', 'list', 'personal', false);
    expect(result.permitted).toBe(true);
  });

  test('global rule overrides default policy', () => {
    perms.addGlobalRule({ provider: 'docker', action: 'stop', allowed: true });
    const result = perms.check('docker', 'stop', 'business', true);
    expect(result.permitted).toBe(true);
    expect(result.reason).toContain('global rule');
  });

  test('context rule works', () => {
    perms.addContextRule('home', { provider: 'fs', action: 'write', allowed: true });
    const result = perms.check('fs', 'write', 'home', true);
    expect(result.permitted).toBe(true);
    expect(result.reason).toContain('home context');
  });
});

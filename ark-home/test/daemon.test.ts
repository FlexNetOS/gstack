// Ark Home — Daemon + API Server Tests

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Conversation } from '../src/conversation';
import { startServer } from '../src/server';
import { ResourceRegistry } from '../src/providers/index';
import { FsProvider } from '../src/providers/fs';
import { PermissionManager } from '../src/permissions';
import { DEFAULT_CONFIG } from '../src/types';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmpDir = mkdtempSync(join(tmpdir(), 'ark-daemon-test-'));
const dataDir = join(tmpDir, 'data');
mkdirSync(dataDir, { recursive: true });

const config = {
  ...DEFAULT_CONFIG,
  dataDir,
  mcpPort: 0, // random port
};

let baseUrl: string;
let handle: { port: number; token: string; stop: () => void };
let authHeaders: Record<string, string>;
let conversation: Conversation;
let resources: ResourceRegistry;
let origCwd: string;

beforeAll(async () => {
  // SemanticRouter opens vectors.db in cwd — isolate to avoid conflicts
  origCwd = process.cwd();
  process.chdir(tmpDir);
  conversation = new Conversation(config);
  resources = new ResourceRegistry();
  resources.register(new FsProvider({ roots: [tmpDir], allowWrite: true, maxReadSize: 1024 * 1024 }));
  await resources.initAll();
  const perms = new PermissionManager(tmpDir);
  // Allow write for tests
  perms.addGlobalRule({ provider: 'fs', action: 'write', allowed: true });
  handle = startServer(conversation, config, resources, perms);
  baseUrl = `http://127.0.0.1:${handle.port}`;
  authHeaders = { 'Authorization': `Bearer ${handle.token}` };
});

afterAll(() => {
  handle?.stop();
  process.chdir(origCwd);
});

describe('daemon health', () => {
  test('GET /api/health returns ok', async () => {
    const resp = await fetch(`${baseUrl}/api/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.memory).toBeDefined();
    expect(body.providers).toBeDefined();
  });
});

describe('conversation API', () => {
  test('POST /api/message requires content', async () => {
    const resp = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  test('POST /api/message accepts valid input', async () => {
    const resp = await fetch(`${baseUrl}/api/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ content: 'hello from test' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.response).toBeDefined();
    expect(body.context).toBeDefined();
    expect(body.stats).toBeDefined();
  });

  test('POST /api/context switches context', async () => {
    const resp = await fetch(`${baseUrl}/api/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ context: 'personal' }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { context: string };
    expect(body.context).toBe('personal');
  });

  test('POST /api/context rejects invalid', async () => {
    const resp = await fetch(`${baseUrl}/api/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ context: 'invalid' }),
    });
    expect(resp.status).toBe(400);
  });

  test('GET /api/stats returns stats', async () => {
    const resp = await fetch(`${baseUrl}/api/stats`, { headers: authHeaders });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(typeof body.total).toBe('number');
  });

  test('GET /api/search requires q param', async () => {
    const resp = await fetch(`${baseUrl}/api/search`, { headers: authHeaders });
    expect(resp.status).toBe(400);
  });

  test('GET /api/search returns results', async () => {
    const resp = await fetch(`${baseUrl}/api/search?q=hello`, { headers: authHeaders });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { results: unknown[]; count: number };
    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe('resource API', () => {
  test('GET /api/resources lists providers', async () => {
    const resp = await fetch(`${baseUrl}/api/resources`, { headers: authHeaders });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { providers: { name: string }[] };
    expect(body.providers.length).toBeGreaterThan(0);
    expect(body.providers.some(p => p.name === 'fs')).toBe(true);
  });

  test('POST /api/resources/fs/list works', async () => {
    const resp = await fetch(`${baseUrl}/api/resources/fs/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ path: tmpDir }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { path: string; entries: unknown[] };
    expect(body.path).toBe(tmpDir);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  test('POST /api/resources/fs/read reads a file', async () => {
    const testFile = join(tmpDir, 'test-read.txt');
    writeFileSync(testFile, 'daemon test content');

    const resp = await fetch(`${baseUrl}/api/resources/fs/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ path: testFile }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { content: string };
    expect(body.content).toBe('daemon test content');
  });

  test('POST /api/resources/fs/write creates a file', async () => {
    const testFile = join(tmpDir, 'test-write.txt');
    const resp = await fetch(`${baseUrl}/api/resources/fs/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ path: testFile, content: 'written by daemon' }),
    });
    expect(resp.status).toBe(200);

    // Verify
    const { readFileSync: rfs } = await import('fs');
    expect(rfs(testFile, 'utf-8')).toBe('written by daemon');
  });

  test('POST /api/resources/unknown/action returns 500', async () => {
    const resp = await fetch(`${baseUrl}/api/resources/nonexistent/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(500);
  });
});

describe('404 handling', () => {
  test('unauthenticated request returns 401', async () => {
    const resp = await fetch(`${baseUrl}/api/stats`);
    expect(resp.status).toBe(401);
  });

  test('unknown route returns 404 with route list', async () => {
    const resp = await fetch(`${baseUrl}/api/nonexistent`, { headers: authHeaders });
    expect(resp.status).toBe(404);
    const body = await resp.json() as { routes: string[] };
    expect(Array.isArray(body.routes)).toBe(true);
  });
});

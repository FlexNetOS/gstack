// Ark Home — Conversation Engine Tests
// Tests the full conversation pipeline without calling the Claude API.
// Each test gets its own temp directory AND changes cwd to it,
// because @ruvector/router's SemanticRouter opens a vectors.db in cwd.

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Conversation } from '../src/conversation';
import type { ArkHomeConfig, ConversationEntry, Context } from '../src/types';

const ORIGINAL_CWD = process.cwd();

function makeConfig(dataDir: string): ArkHomeConfig {
  return {
    dataDir,
    contexts: ['personal', 'business', 'home'],
    activeContext: 'business',
    // No API key — forces offline mode (no LLM calls)
    claudeApiKey: undefined,
    localLlmUrl: 'http://localhost:8081',
    federationPeers: [],
    mcpPort: 7700,
    webUiPort: 7701,
  };
}

function readJsonlEntries(dataDir: string): ConversationEntry[] {
  const logPath = join(dataDir, 'conversation.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ConversationEntry);
}

/**
 * Creates an isolated environment for a Conversation test.
 * Returns a temp dir (used as both cwd and dataDir) and a cleanup function.
 * The SemanticRouter opens vectors.db in cwd, so each test needs its own cwd.
 */
function isolatedConversation(): { conv: Conversation; tmpDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ark-conv-'));
  process.chdir(tmpDir);
  const conv = new Conversation(makeConfig(tmpDir));
  return {
    conv,
    tmpDir,
    cleanup: () => {
      process.chdir(ORIGINAL_CWD);
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('Conversation', () => {
  test('processInput logs user entry and assistant response to JSONL', async () => {
    const { conv, tmpDir, cleanup } = isolatedConversation();
    try {
      const response = await conv.processInput('Hello, Ark Home');

      // Should get an offline-mode response (no API key configured)
      expect(response).toBeTruthy();
      expect(typeof response).toBe('string');

      // JSONL should have at least 2 entries: user input + assistant response
      const entries = readJsonlEntries(tmpDir);
      expect(entries.length).toBeGreaterThanOrEqual(2);

      const userEntry = entries.find(e => e.role === 'user' && e.content === 'Hello, Ark Home');
      expect(userEntry).toBeTruthy();
      expect(userEntry!.context).toBe('business'); // default active context

      const assistantEntry = entries.find(e => e.role === 'assistant');
      expect(assistantEntry).toBeTruthy();
      expect(assistantEntry!.context).toBe('business');
    } finally {
      cleanup();
    }
  });

  test('context switching: personal -> business -> home', () => {
    const { conv, cleanup } = isolatedConversation();
    try {
      // Starts in business
      expect(conv.context).toBe('business');

      // Switch to personal
      expect(conv.switchContext('personal')).toBe(true);
      expect(conv.context).toBe('personal');

      // Switch to home
      expect(conv.switchContext('home')).toBe(true);
      expect(conv.context).toBe('home');

      // Switch back to business
      expect(conv.switchContext('business')).toBe(true);
      expect(conv.context).toBe('business');
    } finally {
      cleanup();
    }
  });

  test('context switch rejects invalid context', () => {
    const { conv, cleanup } = isolatedConversation();
    try {
      expect(conv.switchContext('invalid' as Context)).toBe(false);
      expect(conv.context).toBe('business'); // unchanged
    } finally {
      cleanup();
    }
  });

  test('entries are logged to correct context after switch', async () => {
    const { conv, tmpDir, cleanup } = isolatedConversation();
    try {
      // Log in business context
      await conv.processInput('business message');

      // Switch to personal and log
      conv.switchContext('personal');
      await conv.processInput('personal message');

      // Switch to home and log
      conv.switchContext('home');
      await conv.processInput('home message');

      const entries = readJsonlEntries(tmpDir);
      const userEntries = entries.filter(e => e.role === 'user');

      expect(userEntries).toHaveLength(3);
      expect(userEntries[0].context).toBe('business');
      expect(userEntries[0].content).toBe('business message');
      expect(userEntries[1].context).toBe('personal');
      expect(userEntries[1].content).toBe('personal message');
      expect(userEntries[2].context).toBe('home');
      expect(userEntries[2].content).toBe('home message');
    } finally {
      cleanup();
    }
  });

  test('/search returns matching entries via search()', async () => {
    const { conv, cleanup } = isolatedConversation();
    try {
      await conv.processInput('schedule the plumber for Thursday');
      await conv.processInput('buy groceries at the store');
      await conv.processInput('call the plumber about the kitchen leak');

      const results = conv.search('plumber');
      expect(results.length).toBeGreaterThanOrEqual(2);
      for (const r of results) {
        expect(r.content.toLowerCase()).toContain('plumber');
      }
    } finally {
      cleanup();
    }
  });

  test('search with context filter returns only matching context', async () => {
    const { conv, cleanup } = isolatedConversation();
    try {
      // Business context
      await conv.processInput('invoice the plumber job');

      // Switch to personal
      conv.switchContext('personal');
      await conv.processInput('remind me about the plumber visit');

      const businessResults = conv.search('plumber', 'business');
      const personalResults = conv.search('plumber', 'personal');

      expect(businessResults.length).toBeGreaterThanOrEqual(1);
      expect(personalResults.length).toBeGreaterThanOrEqual(1);

      for (const r of businessResults) {
        expect(r.context).toBe('business');
      }
      for (const r of personalResults) {
        expect(r.context).toBe('personal');
      }
    } finally {
      cleanup();
    }
  });

  test('stats returns correct counts', async () => {
    const { conv, cleanup } = isolatedConversation();
    try {
      // Empty to start
      const s0 = conv.stats();
      expect(s0.total).toBe(0);
      expect(s0.personal).toBe(0);
      expect(s0.business).toBe(0);
      expect(s0.home).toBe(0);

      // Add entries in business (each processInput adds user + assistant = 2 entries)
      await conv.processInput('first business message');
      await conv.processInput('second business message');

      // Add entry in personal
      conv.switchContext('personal');
      await conv.processInput('personal message');

      const s1 = conv.stats();
      // 3 processInput calls = 3 user + 3 assistant = 6 entries
      expect(s1.total).toBe(6);
      expect(s1.business).toBe(4); // 2 user + 2 assistant
      expect(s1.personal).toBe(2); // 1 user + 1 assistant
      expect(s1.home).toBe(0);
    } finally {
      cleanup();
    }
  });

  test('witness chain tracks entries', async () => {
    const { conv, cleanup } = isolatedConversation();
    try {
      await conv.processInput('test witness');

      const ws = conv.witnessStats();
      expect(ws.chainLength).toBeGreaterThan(0);
      expect(ws.verified).toBe(true);
    } finally {
      cleanup();
    }
  });
});

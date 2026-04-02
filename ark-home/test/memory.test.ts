// Ark Home — Memory Layer Tests

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Memory } from '../src/memory';
import type { ConversationEntry, Context } from '../src/types';

function makeEntry(overrides: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    context: 'business',
    role: 'user',
    content: 'test message',
    ...overrides,
  };
}

describe('Memory', () => {
  let tmpDir: string;
  let memory: Memory;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ark-mem-'));
    memory = new Memory(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('appendLog creates JSONL file with correct format', () => {
    const entry = makeEntry({ content: 'hello world' });
    memory.appendLog(entry);

    const raw = readFileSync(join(tmpDir, 'conversation.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as ConversationEntry;
    expect(parsed.id).toBe(entry.id);
    expect(parsed.content).toBe('hello world');
    expect(parsed.context).toBe('business');
    expect(parsed.role).toBe('user');
    expect(parsed.ts).toBeTruthy();
  });

  test('appendLog appends multiple entries as separate lines', () => {
    memory.appendLog(makeEntry({ content: 'first' }));
    memory.appendLog(makeEntry({ content: 'second' }));
    memory.appendLog(makeEntry({ content: 'third' }));

    const raw = readFileSync(join(tmpDir, 'conversation.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(3);

    const entries = lines.map(l => JSON.parse(l) as ConversationEntry);
    expect(entries[0].content).toBe('first');
    expect(entries[1].content).toBe('second');
    expect(entries[2].content).toBe('third');
  });

  test('searchLiteral finds matching entries', () => {
    memory.appendLog(makeEntry({ content: 'schedule the plumber for Thursday' }));
    memory.appendLog(makeEntry({ content: 'buy groceries tomorrow' }));
    memory.appendLog(makeEntry({ content: 'plumber called about the leak' }));

    const results = memory.searchLiteral('plumber');
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain('plumber');
    expect(results[1].content).toContain('plumber');
  });

  test('searchLiteral is case-insensitive', () => {
    memory.appendLog(makeEntry({ content: 'Schedule Meeting with CEO' }));

    const results = memory.searchLiteral('schedule meeting');
    expect(results).toHaveLength(1);
  });

  test('searchLiteral filters by context when specified', () => {
    memory.appendLog(makeEntry({ content: 'plumber job', context: 'business' }));
    memory.appendLog(makeEntry({ content: 'plumber at home', context: 'home' }));

    const businessResults = memory.searchLiteral('plumber', 'business');
    expect(businessResults).toHaveLength(1);
    expect(businessResults[0].context).toBe('business');

    const allResults = memory.searchLiteral('plumber');
    expect(allResults).toHaveLength(2);
  });

  test('searchLiteral returns empty array when no matches', () => {
    memory.appendLog(makeEntry({ content: 'hello world' }));
    const results = memory.searchLiteral('nonexistent');
    expect(results).toHaveLength(0);
  });

  test('searchLiteral returns empty array on empty log', () => {
    const results = memory.searchLiteral('anything');
    expect(results).toHaveLength(0);
  });

  test('getRecent returns last N entries for a context', () => {
    // Add 5 business entries
    for (let i = 0; i < 5; i++) {
      memory.appendLog(makeEntry({ content: `business msg ${i}`, context: 'business' }));
    }
    // Add 3 personal entries
    for (let i = 0; i < 3; i++) {
      memory.appendLog(makeEntry({ content: `personal msg ${i}`, context: 'personal' }));
    }

    const recent = memory.getRecent('business', 3);
    expect(recent).toHaveLength(3);
    // Should be the last 3 business entries
    expect(recent[0].content).toBe('business msg 2');
    expect(recent[1].content).toBe('business msg 3');
    expect(recent[2].content).toBe('business msg 4');
  });

  test('getRecent returns empty array for empty context', () => {
    memory.appendLog(makeEntry({ content: 'business only', context: 'business' }));
    const recent = memory.getRecent('home', 10);
    expect(recent).toHaveLength(0);
  });

  test('getRecent returns all entries if limit exceeds count', () => {
    memory.appendLog(makeEntry({ content: 'one', context: 'personal' }));
    memory.appendLog(makeEntry({ content: 'two', context: 'personal' }));

    const recent = memory.getRecent('personal', 100);
    expect(recent).toHaveLength(2);
  });

  test('count returns correct per-context counts', () => {
    memory.appendLog(makeEntry({ context: 'business' }));
    memory.appendLog(makeEntry({ context: 'business' }));
    memory.appendLog(makeEntry({ context: 'business' }));
    memory.appendLog(makeEntry({ context: 'personal' }));
    memory.appendLog(makeEntry({ context: 'home' }));
    memory.appendLog(makeEntry({ context: 'home' }));

    expect(memory.count()).toBe(6);
    expect(memory.count('business')).toBe(3);
    expect(memory.count('personal')).toBe(1);
    expect(memory.count('home')).toBe(2);
  });

  test('count returns 0 on empty log', () => {
    expect(memory.count()).toBe(0);
    expect(memory.count('business')).toBe(0);
  });

  test('getAll returns every entry', () => {
    memory.appendLog(makeEntry({ content: 'a', context: 'business' }));
    memory.appendLog(makeEntry({ content: 'b', context: 'personal' }));
    memory.appendLog(makeEntry({ content: 'c', context: 'home' }));

    const all = memory.getAll();
    expect(all).toHaveLength(3);
    expect(all.map(e => e.content)).toEqual(['a', 'b', 'c']);
  });
});

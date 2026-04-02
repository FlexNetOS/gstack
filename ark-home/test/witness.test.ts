// Ark Home — Witness Chain Tests

import { describe, test, expect } from 'bun:test';
import { WitnessChain } from '../src/witness';

describe('WitnessChain', () => {
  test('empty chain verifies', () => {
    const chain = new WitnessChain();
    expect(chain.verify()).toBe(true);
    expect(chain.length).toBe(0);
    expect(chain.tip).toBe('0'.repeat(64));
  });

  test('add 5 entries and verify integrity', () => {
    const chain = new WitnessChain();

    const events = [
      { type: 'user_input' as const, payload: 'Hello, Ark Home' },
      { type: 'assistant_response' as const, payload: 'Welcome! How can I help?' },
      { type: 'context_switch' as const, payload: 'personal -> business' },
      { type: 'user_input' as const, payload: 'Schedule a meeting for tomorrow' },
      { type: 'action_proposed' as const, payload: 'calendar.create({date: "2026-04-02"})' },
    ];

    const hashes: string[] = [];
    for (const e of events) {
      const hash = chain.record(e.type, e.payload, `entry-${hashes.length}`);
      hashes.push(hash);
    }

    // Chain length is correct
    expect(chain.length).toBe(5);

    // All hashes are unique
    const unique = new Set(hashes);
    expect(unique.size).toBe(5);

    // Each hash is a 64-char hex string (SHA-256)
    for (const h of hashes) {
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }

    // Tip matches the last hash
    expect(chain.tip).toBe(hashes[4]);

    // Full chain verifies
    expect(chain.verify()).toBe(true);

    // Stats are correct
    const stats = chain.stats();
    expect(stats.chainLength).toBe(5);
    expect(stats.lastHash).toBe(hashes[4]);
    expect(stats.genesisHash).toBe(hashes[0]);
    expect(stats.verified).toBe(true);
  });

  test('chain linkage: each entry references the previous', () => {
    const chain = new WitnessChain();

    chain.record('user_input', 'first');
    chain.record('assistant_response', 'second');
    chain.record('user_input', 'third');

    const entries = chain.allEntries();

    // Genesis prev_hash is all zeros
    expect(entries[0].prev_hash).toBe('0'.repeat(64));

    // Each subsequent entry links to the previous chain_hash
    expect(entries[1].prev_hash).toBe(entries[0].chain_hash);
    expect(entries[2].prev_hash).toBe(entries[1].chain_hash);
  });

  test('tampering breaks verification', () => {
    const chain = new WitnessChain();

    chain.record('user_input', 'legitimate message');
    chain.record('assistant_response', 'legitimate response');
    chain.record('user_input', 'another message');

    // Chain should verify before tampering
    expect(chain.verify()).toBe(true);

    // Tamper with the internal entries (break encapsulation for test)
    const entries = chain.allEntries() as any[];
    // We can't directly tamper with the readonly array, but we can test
    // serialization round-trip with tampered data
    const json = chain.toJSON();
    const parsed = JSON.parse(json);
    parsed.entries[1].action_hash = '0'.repeat(64); // tamper

    expect(() => {
      WitnessChain.fromJSON(JSON.stringify(parsed));
    }).toThrow('Witness chain integrity check failed');
  });

  test('serialization round-trip preserves chain', () => {
    const chain = new WitnessChain();

    chain.record('user_input', 'hello');
    chain.record('assistant_response', 'hi there');
    chain.record('context_switch', 'personal -> home');
    chain.record('system_event', 'energy report generated');
    chain.record('user_input', 'show solar output');

    const json = chain.toJSON();
    const restored = WitnessChain.fromJSON(json);

    expect(restored.length).toBe(5);
    expect(restored.tip).toBe(chain.tip);
    expect(restored.verify()).toBe(true);

    // All entries match
    const origEntries = chain.allEntries();
    const restoredEntries = restored.allEntries();
    for (let i = 0; i < 5; i++) {
      expect(restoredEntries[i].chain_hash).toBe(origEntries[i].chain_hash);
      expect(restoredEntries[i].witness_type).toBe(origEntries[i].witness_type);
    }
  });

  test('verifyRange checks a subset of the chain', () => {
    const chain = new WitnessChain();

    for (let i = 0; i < 10; i++) {
      chain.record('user_input', `message ${i}`);
    }

    // Full range
    expect(chain.verifyRange(0, 9)).toBe(true);

    // Partial ranges
    expect(chain.verifyRange(0, 4)).toBe(true);
    expect(chain.verifyRange(5, 9)).toBe(true);
    expect(chain.verifyRange(3, 7)).toBe(true);

    // Invalid ranges
    expect(chain.verifyRange(-1, 5)).toBe(false);
    expect(chain.verifyRange(0, 10)).toBe(false);
    expect(chain.verifyRange(5, 3)).toBe(false);
  });

  test('getEntry returns correct entry by index', () => {
    const chain = new WitnessChain();

    chain.record('user_input', 'first', 'id-0');
    chain.record('assistant_response', 'second', 'id-1');

    const e0 = chain.getEntry(0);
    expect(e0?.entry_id).toBe('id-0');
    expect(e0?.witness_type).toBe('user_input');
    expect(e0?.index).toBe(0);

    const e1 = chain.getEntry(1);
    expect(e1?.entry_id).toBe('id-1');
    expect(e1?.witness_type).toBe('assistant_response');

    expect(chain.getEntry(99)).toBeUndefined();
  });

  test('chain ID is unique per instance', () => {
    const c1 = new WitnessChain();
    const c2 = new WitnessChain();
    expect(c1.id).not.toBe(c2.id);
    expect(c1.id).toMatch(/^[0-9a-f]{32}$/);
  });
});

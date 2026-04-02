// Ark Home — Witness Chain
// Cryptographic chain of conversation events.
// Each entry links to the previous via SHA-256, mirroring rvf's native witness
// chain format (SHAKE-256, 73 bytes per entry). When the Rust binary is
// available the TypeScript-side chain can be verified against rvf's chain.

import { createHash, randomBytes } from 'crypto';

// ── Types ──────────────────────────────────────────────────────────────

export type WitnessType =
  | 'user_input'
  | 'assistant_response'
  | 'context_switch'
  | 'search_query'
  | 'action_proposed'
  | 'action_approved'
  | 'action_rejected'
  | 'vector_ingest'
  | 'system_event';

export interface WitnessEntry {
  /** Index in the chain (0-based) */
  index: number;
  /** SHA-256 of the previous entry (hex). Genesis entry uses zeros. */
  prev_hash: string;
  /** SHA-256 of the action payload (hex) */
  action_hash: string;
  /** Combined chain hash: SHA-256(prev_hash + action_hash + timestamp) */
  chain_hash: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Classification of the witnessed event */
  witness_type: WitnessType;
  /** Optional reference back to the conversation entry id */
  entry_id?: string;
}

export interface WitnessStats {
  chainLength: number;
  lastHash: string;
  genesisHash: string;
  verified: boolean;
  createdAt: string;
  lastEntryAt: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const ZERO_HASH = '0'.repeat(64); // 32 bytes of zeros in hex

// ── Helpers ────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf-8').digest('hex');
}

// ── WitnessChain ───────────────────────────────────────────────────────

export class WitnessChain {
  private entries: WitnessEntry[] = [];
  private chainId: string;
  private createdAt: string;

  constructor() {
    this.chainId = randomBytes(16).toString('hex');
    this.createdAt = new Date().toISOString();
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Record a new event in the witness chain.
   * Returns the chain hash for the caller to attach to conversation entries.
   */
  record(
    witnessType: WitnessType,
    payload: string,
    entryId?: string,
  ): string {
    const prevHash = this.entries.length === 0
      ? ZERO_HASH
      : this.entries[this.entries.length - 1].chain_hash;

    const timestamp = new Date().toISOString();
    const actionHash = sha256(payload);
    const chainHash = sha256(prevHash + actionHash + timestamp);

    const entry: WitnessEntry = {
      index: this.entries.length,
      prev_hash: prevHash,
      action_hash: actionHash,
      chain_hash: chainHash,
      timestamp,
      witness_type: witnessType,
      entry_id: entryId,
    };

    this.entries.push(entry);
    return chainHash;
  }

  /**
   * Verify the entire chain from genesis to tip.
   * Returns true only if every link is valid.
   */
  verify(): boolean {
    if (this.entries.length === 0) return true;

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      // Check prev_hash linkage
      const expectedPrev = i === 0
        ? ZERO_HASH
        : this.entries[i - 1].chain_hash;

      if (entry.prev_hash !== expectedPrev) return false;

      // Recompute chain_hash
      const recomputed = sha256(
        entry.prev_hash + entry.action_hash + entry.timestamp,
      );
      if (entry.chain_hash !== recomputed) return false;
    }

    return true;
  }

  /**
   * Verify a subset of the chain (from startIndex to endIndex inclusive).
   * Useful for incremental verification without re-checking the full chain.
   */
  verifyRange(startIndex: number, endIndex: number): boolean {
    if (startIndex < 0 || endIndex >= this.entries.length || startIndex > endIndex) {
      return false;
    }

    for (let i = startIndex; i <= endIndex; i++) {
      const entry = this.entries[i];

      const expectedPrev = i === 0
        ? ZERO_HASH
        : this.entries[i - 1].chain_hash;

      if (entry.prev_hash !== expectedPrev) return false;

      const recomputed = sha256(
        entry.prev_hash + entry.action_hash + entry.timestamp,
      );
      if (entry.chain_hash !== recomputed) return false;
    }

    return true;
  }

  /** Return the most recent chain hash (the chain tip). */
  get tip(): string {
    if (this.entries.length === 0) return ZERO_HASH;
    return this.entries[this.entries.length - 1].chain_hash;
  }

  /** Return chain statistics. */
  stats(): WitnessStats {
    return {
      chainLength: this.entries.length,
      lastHash: this.tip,
      genesisHash: this.entries.length > 0
        ? this.entries[0].chain_hash
        : ZERO_HASH,
      verified: this.verify(),
      createdAt: this.createdAt,
      lastEntryAt: this.entries.length > 0
        ? this.entries[this.entries.length - 1].timestamp
        : this.createdAt,
    };
  }

  /** Return a copy of all entries (immutable export). */
  allEntries(): readonly WitnessEntry[] {
    return [...this.entries];
  }

  /** Return a specific entry by index. */
  getEntry(index: number): WitnessEntry | undefined {
    return this.entries[index];
  }

  /** Return the chain ID (random per instance). */
  get id(): string {
    return this.chainId;
  }

  /** Return the chain length. */
  get length(): number {
    return this.entries.length;
  }

  // ── Serialization ──────────────────────────────────────────────────

  /** Serialize the full chain to JSON (for persistence / federation). */
  toJSON(): string {
    return JSON.stringify({
      chainId: this.chainId,
      createdAt: this.createdAt,
      entries: this.entries,
    });
  }

  /** Restore a chain from its JSON representation. */
  static fromJSON(json: string): WitnessChain {
    const data = JSON.parse(json) as {
      chainId: string;
      createdAt: string;
      entries: WitnessEntry[];
    };

    const chain = new WitnessChain();
    chain.chainId = data.chainId;
    chain.createdAt = data.createdAt;
    chain.entries = data.entries;

    if (!chain.verify()) {
      throw new Error('Witness chain integrity check failed during deserialization');
    }

    return chain;
  }
}

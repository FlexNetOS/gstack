// Ark Home — Triple-Layer Memory
// Layer 1: JSONL log (literal recall)
// Layer 2: rvf vectors (semantic search via @ruvector/rvf)
// Layer 3: Witness chain (cryptographic linkage — future)

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { RvfDatabase } from '@ruvector/rvf';
import { embedText, EMBEDDING_DIM } from './embedding';
import type { ConversationEntry, Context, SearchResult } from './types';

export class Memory {
  private logPath: string;
  private dataDir: string;

  // Layer 2: rvf vector stores — one per context namespace
  private rvfStores: Map<string, RvfDatabase> = new Map();
  private rvfReady = false;
  private rvfInitPromise: Promise<void> | null = null;

  // In-memory map from rvf vector IDs to conversation entry IDs
  private vectorToEntryId: Map<string, string> = new Map();
  private nextVectorId = 1;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.logPath = join(dataDir, 'conversation.jsonl');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  }

  /**
   * Initialize rvf stores for semantic search.
   * Creates one RvfDatabase per context namespace.
   * Idempotent — safe to call multiple times.
   */
  async initRvf(): Promise<void> {
    if (this.rvfReady) return;
    if (this.rvfInitPromise) return this.rvfInitPromise;

    this.rvfInitPromise = this._initRvfInternal();
    await this.rvfInitPromise;
  }

  private async _initRvfInternal(): Promise<void> {
    const rvfDir = join(this.dataDir, 'rvf');
    if (!existsSync(rvfDir)) mkdirSync(rvfDir, { recursive: true });

    const contexts: Context[] = ['personal', 'business', 'home'];
    for (const ctx of contexts) {
      const storePath = join(rvfDir, `${ctx}.rvf`);
      try {
        let db: RvfDatabase;
        if (existsSync(storePath)) {
          db = await RvfDatabase.open(storePath);
        } else {
          db = await RvfDatabase.create(storePath, {
            dimensions: EMBEDDING_DIM,
            metric: 'cosine',
            m: 16,
            efConstruction: 200,
          });
        }
        this.rvfStores.set(ctx, db);
      } catch (err) {
        console.error(`[memory] Failed to init rvf store for ${ctx}:`, err);
      }
    }

    // Reindex existing JSONL entries that don't have rvf_vector_id
    await this._reindexExisting();
    this.rvfReady = true;
  }

  /**
   * Reindex existing JSONL entries into rvf stores.
   */
  private async _reindexExisting(): Promise<void> {
    if (!existsSync(this.logPath)) return;

    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
    const batch: Map<string, Array<{ id: string; vector: Float32Array | number[] }>> = new Map();

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ConversationEntry;
        if (!entry.content || entry.content.length < 3) continue;

        const vectorId = String(this.nextVectorId++);
        this.vectorToEntryId.set(vectorId, entry.id);

        if (!batch.has(entry.context)) batch.set(entry.context, []);
        batch.get(entry.context)!.push({
          id: vectorId,
          vector: Array.from(embedText(entry.content)),
        });
      } catch {
        // skip malformed lines
      }
    }

    for (const [ctx, entries] of batch) {
      const store = this.rvfStores.get(ctx);
      if (!store || entries.length === 0) continue;
      try {
        await store.ingestBatch(entries);
      } catch (err) {
        console.error(`[memory] Failed to reindex ${ctx}:`, err);
      }
    }
  }

  // Layer 1: Append to JSONL log
  appendLog(entry: ConversationEntry): void {
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    // Fire-and-forget rvf indexing
    this._indexEntry(entry).catch(() => {});
  }

  /**
   * Index a single entry into the rvf store for its context.
   */
  private async _indexEntry(entry: ConversationEntry): Promise<void> {
    if (!this.rvfReady) return;
    if (!entry.content || entry.content.length < 3) return;

    const store = this.rvfStores.get(entry.context);
    if (!store) return;

    const vectorId = String(this.nextVectorId++);
    this.vectorToEntryId.set(vectorId, entry.id);

    try {
      await store.ingestBatch([{
        id: vectorId,
        vector: Array.from(embedText(entry.content)),
      }]);
    } catch (err) {
      // Non-fatal — literal search still works
    }
  }

  // Layer 1: Literal search (grep through JSONL)
  searchLiteral(query: string, context?: Context, limit = 10): ConversationEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
    const queryLower = query.toLowerCase();

    return lines
      .map(line => JSON.parse(line) as ConversationEntry)
      .filter(e => e.content.toLowerCase().includes(queryLower))
      .filter(e => !context || e.context === context)
      .slice(-limit);
  }

  /**
   * Layer 2: Semantic search via rvf vector similarity.
   * Returns entries ranked by embedding distance.
   */
  async searchSemantic(query: string, context?: Context, limit = 10): Promise<SearchResult[]> {
    if (!this.rvfReady) return [];

    const queryVec = embedText(query);
    const results: SearchResult[] = [];
    const contexts: Context[] = context ? [context] : ['personal', 'business', 'home'];

    for (const ctx of contexts) {
      const store = this.rvfStores.get(ctx);
      if (!store) continue;

      try {
        const status = await store.status();
        if (status.totalVectors === 0) continue;

        const hits = await store.query(Array.from(queryVec), limit);
        for (const hit of hits) {
          const entryId = this.vectorToEntryId.get(hit.id);
          if (!entryId) continue;

          const entry = this._findEntryById(entryId);
          if (!entry) continue;

          // Convert distance to similarity (cosine distance: lower = more similar)
          const similarity = 1.0 - hit.distance;
          results.push({ entry, similarity, source: 'semantic' });
        }
      } catch (err) {
        // Non-fatal
      }
    }

    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Combined search: literal + semantic, deduplicated.
   */
  async searchCombined(query: string, context?: Context, limit = 10): Promise<SearchResult[]> {
    const literal = this.searchLiteral(query, context, limit).map(entry => ({
      entry,
      similarity: 1.0, // exact match = max similarity
      source: 'literal' as const,
    }));

    const semantic = await this.searchSemantic(query, context, limit);

    // Deduplicate by entry ID, preferring literal matches
    const seen = new Set<string>();
    const combined: SearchResult[] = [];

    for (const r of literal) {
      if (!seen.has(r.entry.id)) {
        seen.add(r.entry.id);
        combined.push(r);
      }
    }
    for (const r of semantic) {
      if (!seen.has(r.entry.id)) {
        seen.add(r.entry.id);
        combined.push(r);
      }
    }

    return combined.slice(0, limit);
  }

  /**
   * Find an entry by ID in the JSONL log.
   */
  private _findEntryById(id: string): ConversationEntry | null {
    if (!existsSync(this.logPath)) return null;
    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as ConversationEntry;
        if (entry.id === id) return entry;
      } catch {
        continue;
      }
    }
    return null;
  }

  // Get recent entries for context window
  getRecent(context: Context, limit = 20): ConversationEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);

    return lines
      .map(line => JSON.parse(line) as ConversationEntry)
      .filter(e => e.context === context)
      .slice(-limit);
  }

  // Get all entries (for export/federation)
  getAll(): ConversationEntry[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as ConversationEntry);
  }

  // Count entries
  count(context?: Context): number {
    if (!existsSync(this.logPath)) return 0;
    const lines = readFileSync(this.logPath, 'utf-8').split('\n').filter(Boolean);
    if (!context) return lines.length;
    return lines.filter(line => {
      const e = JSON.parse(line) as ConversationEntry;
      return e.context === context;
    }).length;
  }

  /**
   * Get rvf store status for a context.
   */
  async rvfStatus(context: Context): Promise<{ vectors: number; ready: boolean }> {
    if (!this.rvfReady) return { vectors: 0, ready: false };
    const store = this.rvfStores.get(context);
    if (!store) return { vectors: 0, ready: false };
    try {
      const status = await store.status();
      return { vectors: status.totalVectors, ready: true };
    } catch {
      return { vectors: 0, ready: false };
    }
  }

  /**
   * Close all rvf stores gracefully.
   */
  async close(): Promise<void> {
    for (const [, store] of this.rvfStores) {
      try {
        await store.close();
      } catch {
        // ignore close errors
      }
    }
    this.rvfStores.clear();
    this.rvfReady = false;
  }
}

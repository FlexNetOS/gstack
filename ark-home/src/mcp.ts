// Ark Home — MCP Server Bridge
// Starts the rvf binary in serve mode as a subprocess and exposes its tools
// to the conversation engine. The rvf CLI provides: create, ingest, query,
// status, verify-witness, inspect, compact, and more.
//
// This bridge wraps the CLI rather than a separate MCP server package,
// since @ruvector/rvf-mcp-server is not installed. The CLI is the source
// of truth and always available at ~/.cargo/bin/rvf.

import { spawn, execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Types ──────────────────────────────────────────────────────────────

export interface RvfStoreInfo {
  path: string;
  dimension: number;
  metric: string;
  vectorCount?: number;
  witnessCount?: number;
}

export interface RvfIngestItem {
  id: string;
  vector: number[];
}

export interface RvfQueryResult {
  id: string;
  distance: number;
}

export interface McpBridgeConfig {
  /** Path to rvf binary. Defaults to ~/.cargo/bin/rvf */
  rvfBinary?: string;
  /** Directory for rvf store files */
  dataDir: string;
  /** Vector dimensionality for new stores */
  dimension?: number;
  /** Distance metric: l2, ip, cosine */
  metric?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function defaultRvfBinary(): string {
  const home = process.env.HOME || '/root';
  return join(home, '.cargo', 'bin', 'rvf');
}

function runRvf(binary: string, args: string[]): string {
  try {
    const result = execFileSync(binary, args, {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return result.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`rvf command failed: ${args.join(' ')}\n${msg}`);
  }
}

function runRvfJSON(binary: string, args: string[]): unknown {
  const raw = runRvf(binary, [...args, '--json']);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ── McpBridge ──────────────────────────────────────────────────────────

export class McpBridge {
  private binary: string;
  private dataDir: string;
  private dimension: number;
  private metric: string;
  private stores = new Map<string, string>(); // name → file path

  constructor(config: McpBridgeConfig) {
    this.binary = config.rvfBinary ?? defaultRvfBinary();
    this.dataDir = config.dataDir;
    this.dimension = config.dimension ?? 1536; // Claude embedding dimension
    this.metric = config.metric ?? 'cosine';
  }

  // ── Tool: rvf_create_store ─────────────────────────────────────────

  /**
   * Create a new rvf vector store.
   * Maps to: rvf create --dimension <dim> --metric <metric> <path>
   */
  createStore(name: string, opts?: { dimension?: number; metric?: string }): RvfStoreInfo {
    const dim = opts?.dimension ?? this.dimension;
    const metric = opts?.metric ?? this.metric;
    const storePath = join(this.dataDir, `${name}.rvf`);

    if (existsSync(storePath)) {
      throw new Error(`Store already exists: ${storePath}`);
    }

    runRvf(this.binary, [
      'create',
      '--dimension', String(dim),
      '--metric', metric,
      storePath,
    ]);

    this.stores.set(name, storePath);

    return { path: storePath, dimension: dim, metric };
  }

  // ── Tool: rvf_open_store ───────────────────────────────────────────

  /**
   * Open an existing rvf store for subsequent operations.
   * Validates the file exists and registers it by name.
   */
  openStore(name: string, path?: string): RvfStoreInfo {
    const storePath = path ?? join(this.dataDir, `${name}.rvf`);

    if (!existsSync(storePath)) {
      throw new Error(`Store not found: ${storePath}`);
    }

    this.stores.set(name, storePath);

    // Get status for dimension/metric info
    const status = this.status(name);
    return {
      path: storePath,
      dimension: (status as Record<string, unknown>)?.dimension as number ?? this.dimension,
      metric: (status as Record<string, unknown>)?.metric as string ?? this.metric,
      vectorCount: (status as Record<string, unknown>)?.vector_count as number,
      witnessCount: (status as Record<string, unknown>)?.witness_count as number,
    };
  }

  // ── Tool: rvf_ingest ───────────────────────────────────────────────

  /**
   * Ingest vectors into a named store.
   * Maps to: rvf ingest --input <tmpfile> <path>
   */
  ingest(name: string, items: RvfIngestItem[]): { ingested: number } {
    const storePath = this.resolveStore(name);

    // Write items to a temp JSON file (rvf reads from file, not stdin)
    const tmpPath = join(tmpdir(), `ark-ingest-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify(items));

    try {
      runRvf(this.binary, ['ingest', '--input', tmpPath, storePath]);
      return { ingested: items.length };
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
    }
  }

  // ── Tool: rvf_query ────────────────────────────────────────────────

  /**
   * Query nearest neighbors from a named store.
   * Maps to: rvf query --vector <csv> --k <k> <path>
   */
  query(
    name: string,
    vector: number[],
    k = 10,
  ): RvfQueryResult[] {
    const storePath = this.resolveStore(name);
    const vectorCsv = vector.join(',');

    const result = runRvfJSON(this.binary, [
      'query',
      '--vector', `"${vectorCsv}"`,
      '--k', String(k),
      storePath,
    ]);

    if (Array.isArray(result)) {
      return result as RvfQueryResult[];
    }

    // rvf may return results in a wrapper object
    if (result && typeof result === 'object' && 'results' in (result as Record<string, unknown>)) {
      return (result as Record<string, unknown>).results as RvfQueryResult[];
    }

    return [];
  }

  // ── Tool: rvf_status ───────────────────────────────────────────────

  /**
   * Get status of a named store.
   * Maps to: rvf status --json <path>
   */
  status(name: string): unknown {
    const storePath = this.resolveStore(name);
    return runRvfJSON(this.binary, ['status', storePath]);
  }

  // ── Tool: rvf_verify_witness ───────────────────────────────────────

  /**
   * Verify the witness chain in a named store.
   * Maps to: rvf verify-witness --json <path>
   */
  verifyWitness(name: string): unknown {
    const storePath = this.resolveStore(name);
    return runRvfJSON(this.binary, ['verify-witness', storePath]);
  }

  // ── Tool: rvf_inspect ──────────────────────────────────────────────

  /**
   * Inspect segments and lineage of a named store.
   * Maps to: rvf inspect --json <path>
   */
  inspect(name: string): unknown {
    const storePath = this.resolveStore(name);
    return runRvfJSON(this.binary, ['inspect', storePath]);
  }

  // ── Tool: rvf_compact ─────────────────────────────────────────────

  /**
   * Compact a store to reclaim dead space.
   * Maps to: rvf compact <path>
   */
  compact(name: string): void {
    const storePath = this.resolveStore(name);
    runRvf(this.binary, ['compact', storePath]);
  }

  // ── Utility ────────────────────────────────────────────────────────

  /** Check whether the rvf binary is available. */
  isAvailable(): boolean {
    try {
      runRvf(this.binary, ['--version']);
      return true;
    } catch {
      return false;
    }
  }

  /** List all registered stores. */
  listStores(): Map<string, string> {
    return new Map(this.stores);
  }

  // ── Private ────────────────────────────────────────────────────────

  private resolveStore(name: string): string {
    const path = this.stores.get(name);
    if (!path) {
      // Try the default path
      const defaultPath = join(this.dataDir, `${name}.rvf`);
      if (existsSync(defaultPath)) {
        this.stores.set(name, defaultPath);
        return defaultPath;
      }
      throw new Error(`Store not registered and not found at default path: ${name}`);
    }
    return path;
  }
}

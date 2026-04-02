// Ark Home — Persistent AI Types

export type Context = 'personal' | 'business' | 'home';

// ── Witness Chain Types ──────────────────────────────────────────────

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
  index: number;
  prev_hash: string;
  action_hash: string;
  chain_hash: string;
  timestamp: string;
  witness_type: WitnessType;
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

// ── MCP Bridge Types ─────────────────────────────────────────────────

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
  rvfBinary?: string;
  dataDir: string;
  dimension?: number;
  metric?: string;
}

export interface ConversationEntry {
  id: string;
  ts: string;
  context: Context;
  role: 'user' | 'assistant' | 'system';
  content: string;
  rvf_vector_id?: string;
  witness_hash?: string;
  sona_trajectory_id?: number;
}

export interface SearchResult {
  entry: ConversationEntry;
  similarity: number;
  source: 'literal' | 'semantic';
}

export interface ActionProposal {
  description: string;
  tool: string;
  args: Record<string, unknown>;
  confidence: number;
  gate_approved: boolean;
  witness_hash?: string;
}

export interface SonaStats {
  trajectoriesRecorded: number;
  patternsLearned: number;
  microLoraUpdates: number;
  baseLoraUpdates: number;
  avgLearningTimeMs: number;
}

export interface ArkHomeConfig {
  dataDir: string;
  contexts: Context[];
  activeContext: Context;
  claudeApiKey?: string;
  localLlmUrl?: string;
  federationPeers: string[];
  mcpPort: number;
  webUiPort: number;
}

export const DEFAULT_CONFIG: ArkHomeConfig = {
  dataDir: './data',
  contexts: ['personal', 'business', 'home'],
  activeContext: 'business',
  claudeApiKey: process.env.ANTHROPIC_API_KEY,
  localLlmUrl: 'http://localhost:8081',
  federationPeers: [],
  mcpPort: 7700,
  webUiPort: 7701,
};

// ── Resource Provider Types ─────────────────────────────────────────

export interface ResourceActionResult {
  provider: string;
  action: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

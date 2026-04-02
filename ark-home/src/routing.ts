// Ark Home — Semantic Intent Router
// Wraps @ruvector/router SemanticRouter for intent classification.
// Routes user input to: scheduling, invoicing, search, context-switch, general-chat.

import { SemanticRouter, type RouteResult } from '@ruvector/router';
import { embedText, embedAsync, EMBEDDING_DIM } from './embedding';

export type IntentName =
  | 'scheduling' | 'invoicing' | 'search' | 'context-switch' | 'general-chat'
  | 'resource-fs' | 'resource-docker' | 'resource-network';

export interface IntentDefinition {
  name: IntentName;
  utterances: string[];
  metadata?: Record<string, unknown>;
}

const INTENT_DEFINITIONS: IntentDefinition[] = [
  {
    name: 'scheduling',
    utterances: [
      'schedule a meeting for tomorrow',
      'book an appointment at 3pm',
      'what is on my calendar this week',
      'set a reminder for Friday',
      'reschedule the meeting with the client',
      'when is my next appointment',
      'block off time for lunch',
      'cancel the 2pm meeting',
    ],
    metadata: { priority: 'high', category: 'action' },
  },
  {
    name: 'invoicing',
    utterances: [
      'create an invoice for the Smith job',
      'send the invoice to the client',
      'how much do we owe on the Johnson project',
      'generate a billing statement',
      'mark invoice 1234 as paid',
      'what invoices are outstanding',
      'create an estimate for the new project',
      'track payment received from ABC Corp',
    ],
    metadata: { priority: 'high', category: 'action' },
  },
  {
    name: 'search',
    utterances: [
      'find the conversation about the roof repair',
      'search for messages about budget',
      'what did we discuss about the kitchen remodel',
      'look up the notes on the Smith project',
      'find previous discussion about pricing',
      'search all contexts for electricity bill',
    ],
    metadata: { priority: 'medium', category: 'query' },
  },
  {
    name: 'context-switch',
    utterances: [
      'switch to personal',
      'go to business mode',
      'change to home context',
      'switch context to personal',
      'let me switch to business',
      'I want to talk about home stuff',
    ],
    metadata: { priority: 'low', category: 'navigation' },
  },
  {
    name: 'general-chat',
    utterances: [
      'hello how are you',
      'what do you think about this',
      'tell me a story',
      'help me think through this problem',
      'good morning',
      'thanks for your help',
      'can you explain that again',
      'I have a question',
    ],
    metadata: { priority: 'low', category: 'conversation' },
  },
  {
    name: 'resource-fs',
    utterances: [
      'list files in my home directory',
      'what files are in the project folder',
      'read the config file',
      'show me the contents of that file',
      'search for files named readme',
      'how much disk space is used',
      'what is in the documents folder',
      'find the log file',
    ],
    metadata: { priority: 'medium', category: 'resource', provider: 'fs' },
  },
  {
    name: 'resource-docker',
    utterances: [
      'what containers are running',
      'list all docker containers',
      'show me the docker images',
      'restart the postgres container',
      'stop the redis container',
      'start the web server container',
      'show container logs for nginx',
      'what is the status of my services',
    ],
    metadata: { priority: 'high', category: 'resource', provider: 'docker' },
  },
  {
    name: 'resource-network',
    utterances: [
      'scan the local network',
      'what services are running on this machine',
      'check if the API is up',
      'what ports are open',
      'discover other devices on the network',
      'is the server reachable',
      'check network health',
      'find other Ark Home instances',
    ],
    metadata: { priority: 'medium', category: 'resource', provider: 'network' },
  },
];

export class IntentRouter {
  private router: SemanticRouter;
  private initialized = false;

  constructor() {
    this.router = new SemanticRouter({
      dimension: EMBEDDING_DIM,
      metric: 'cosine',
      threshold: 0.3, // N-gram embeddings: similar texts ~0.3-0.75, dissimilar ~0.0-0.2
    });

    // Set the async embedder for text-based routing
    this.router.setEmbedder(embedAsync);
  }

  /**
   * Initialize the router with all intent definitions.
   * Must be called before routing. Idempotent.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    for (const intent of INTENT_DEFINITIONS) {
      // Compute centroid embedding from utterances
      const embeddings = intent.utterances.map(u => embedText(u));
      const centroid = new Float32Array(EMBEDDING_DIM);

      for (const emb of embeddings) {
        for (let i = 0; i < EMBEDDING_DIM; i++) {
          centroid[i] += emb[i] / embeddings.length;
        }
      }

      // L2 normalize the centroid
      let norm = 0;
      for (let i = 0; i < EMBEDDING_DIM; i++) norm += centroid[i] * centroid[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < EMBEDDING_DIM; i++) centroid[i] /= norm;

      this.router.addIntent({
        name: intent.name,
        utterances: intent.utterances,
        embedding: centroid,
        metadata: intent.metadata,
      });
    }

    this.initialized = true;
  }

  /**
   * Route user input to the best matching intent.
   * Returns the top match and its confidence score.
   */
  route(input: string): { intent: IntentName; score: number; metadata?: Record<string, unknown> } {
    if (!this.initialized) {
      return { intent: 'general-chat', score: 0 };
    }

    const embedding = embedText(input);
    const results = this.router.routeWithEmbedding(embedding, 3);

    if (results.length === 0) {
      return { intent: 'general-chat', score: 0 };
    }

    return {
      intent: results[0].intent as IntentName,
      score: results[0].score,
      metadata: results[0].metadata,
    };
  }

  /**
   * Route with full results (top k matches).
   */
  routeAll(input: string, k: number = 3): RouteResult[] {
    if (!this.initialized) return [];
    const embedding = embedText(input);
    return this.router.routeWithEmbedding(embedding, k);
  }

  /**
   * Get all registered intent names.
   */
  getIntents(): string[] {
    return this.router.getIntents();
  }

  /**
   * Save router state to disk for persistence.
   */
  async save(filePath: string): Promise<void> {
    await this.router.save(filePath);
  }

  /**
   * Load router state from disk.
   */
  async load(filePath: string): Promise<void> {
    await this.router.load(filePath);
    this.initialized = true;
  }
}

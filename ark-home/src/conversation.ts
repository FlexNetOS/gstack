// Ark Home — Conversation Engine
// The main loop: input -> embed -> route intent -> search context -> act -> log -> learn

import Anthropic from '@anthropic-ai/sdk';
import { Memory } from './memory';
import { ContextManager } from './context';
import { LearningEngine } from './learning';
import { IntentRouter, type IntentName } from './routing';
import { WitnessChain } from './witness';
import type { WitnessStats } from './witness';
import { SafetyGate } from './safety';
import type { ConversationEntry, Context, ArkHomeConfig, SonaStats } from './types';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

export class Conversation {
  private memory: Memory;
  private contextMgr: ContextManager;
  private claude: Anthropic | null = null;
  private config: ArkHomeConfig;

  // RuVector subsystems
  private learning: LearningEngine;
  private router: IntentRouter;
  private initialized = false;

  // Witness chain — cryptographic audit trail
  private witness: WitnessChain;
  private witnessPath: string;

  // Safety gate — Cognitum Gate integration
  private safetyGate: SafetyGate;

  constructor(config: ArkHomeConfig) {
    this.config = config;
    this.memory = new Memory(config.dataDir);
    this.contextMgr = new ContextManager(config);
    this.learning = new LearningEngine();
    this.router = new IntentRouter();

    // Load or create witness chain
    this.witnessPath = join(config.dataDir, 'witness.json');
    this.witness = this._loadWitnessChain();

    // Safety gate (async init happens in _initAsync)
    this.safetyGate = new SafetyGate();

    if (config.claudeApiKey) {
      this.claude = new Anthropic({ apiKey: config.claudeApiKey });
    }

    // Initialize async subsystems in background
    this._initAsync().catch(err => {
      console.error('[ark-home] Async init failed:', err);
    });
  }

  private async _initAsync(): Promise<void> {
    await Promise.all([
      this.memory.initRvf(),
      this.router.initialize(),
      this.safetyGate.init(),
    ]);
    this.initialized = true;
  }

  private _loadWitnessChain(): WitnessChain {
    try {
      if (existsSync(this.witnessPath)) {
        const json = readFileSync(this.witnessPath, 'utf-8');
        return WitnessChain.fromJSON(json);
      }
    } catch (err) {
      console.error('[ark-home] Witness chain load failed, starting fresh:', err);
    }
    return new WitnessChain();
  }

  private _persistWitness(): void {
    try {
      const dir = dirname(this.witnessPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.witnessPath, this.witness.toJSON(), 'utf-8');
    } catch (err) {
      console.error('[ark-home] Witness chain persist failed:', err);
    }
  }

  /** Return witness chain statistics. */
  witnessStats(): WitnessStats {
    return this.witness.stats();
  }

  /** Return safety gate statistics. */
  safetyStats(): { available: boolean; actionsChecked: number; actionsBlocked: number } {
    return this.safetyGate.stats();
  }

  get context(): Context {
    return this.contextMgr.current;
  }

  switchContext(to: Context): boolean {
    return this.contextMgr.switch(to);
  }

  async processInput(input: string): Promise<string> {
    const context = this.contextMgr.current;

    // 1. Route intent via SemanticRouter
    let intentResult = { intent: 'general-chat' as IntentName, score: 0 };
    try {
      intentResult = this.router.route(input);
    } catch {
      // Router not ready yet — fall through to general-chat
    }

    // 2. Begin SONA trajectory for this turn
    let trajectoryId: number | null = null;
    try {
      trajectoryId = this.learning.beginTurn(input, context);
      this.learning.setRoute(intentResult.intent);
    } catch {
      // Learning engine may not be ready
    }

    // 3. Auto-detect context suggestion
    const detected = this.contextMgr.detectContext(input);
    if (detected && detected !== context) {
      // Don't auto-switch, just note it
    }

    // 4. Log user input + witness
    const userEntry: ConversationEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      context,
      role: 'user',
      content: input,
      sona_trajectory_id: trajectoryId ?? undefined,
    };
    userEntry.witness_hash = this.witness.record('user_input', input, userEntry.id);
    this._persistWitness();
    this.memory.appendLog(userEntry);

    // 5. Get recent context for the conversation window
    const recentEntries = this.memory.getRecent(context, 20);
    const messages = recentEntries.map(e => ({
      role: e.role as 'user' | 'assistant',
      content: e.content,
    }));

    // 6. Semantic search for relevant past context
    let semanticContext = '';
    try {
      const semanticResults = await this.memory.searchSemantic(input, context, 5);
      if (semanticResults.length > 0) {
        const snippets = semanticResults
          .filter(r => r.similarity > 0.3)
          .map(r => `[${r.entry.ts.slice(0, 10)}] ${r.entry.content.slice(0, 200)}`);
        if (snippets.length > 0) {
          semanticContext = `\n\nRelevant past context (semantic search):\n${snippets.join('\n')}`;
        }
      }
    } catch {
      // Semantic search not available
    }

    // 7. Find SONA learned patterns for context enrichment
    let patternContext = '';
    try {
      const patterns = this.learning.findPatterns(input, 3);
      if (patterns.length > 0) {
        const patternInfo = patterns
          .filter(p => p.avgQuality > 0.5)
          .map(p => `Pattern ${p.id}: quality=${p.avgQuality.toFixed(2)}, used=${p.accessCount}x`);
        if (patternInfo.length > 0) {
          patternContext = `\n\nLearned patterns: ${patternInfo.join('; ')}`;
        }
      }
    } catch {
      // Pattern search not available
    }

    // 8. Build system prompt with enriched context
    const systemPrompt = this.buildSystemPrompt(context, intentResult.intent, semanticContext, patternContext);

    // 8.5. Safety gate check — if the input involves a real-world action, verify with Cognitum Gate
    let safetyToken: string | undefined;
    if (this.safetyGate.isActionIntent(input)) {
      const check = await this.safetyGate.checkAction(input, context);
      safetyToken = check.token;
      if (!check.permitted) {
        // Blocked by safety gate — return early without calling LLM
        const blockedResponse = `I paused before doing this because ${check.reason} (confidence: ${(check.confidence * 100).toFixed(0)}%). Want me to proceed anyway?`;
        // Still log the blocked response
        const blockedEntry: ConversationEntry = {
          id: randomUUID(),
          ts: new Date().toISOString(),
          context,
          role: 'assistant',
          content: blockedResponse,
          sona_trajectory_id: trajectoryId ?? undefined,
        };
        blockedEntry.witness_hash = this.witness.record('action_rejected', input, blockedEntry.id);
        this._persistWitness();
        this.memory.appendLog(blockedEntry);
        return blockedResponse;
      }
    }

    // 9. Call LLM
    let response: string;
    try {
      response = await this.callLLM(systemPrompt, messages);
    } catch (err) {
      response = `I'm having trouble connecting to the AI service. Error: ${err instanceof Error ? err.message : 'unknown'}. I'll keep your message and try again when the connection is restored.`;
    }

    // 10. Log assistant response + witness
    const assistantEntry: ConversationEntry = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      context,
      role: 'assistant',
      content: response,
      sona_trajectory_id: trajectoryId ?? undefined,
    };
    assistantEntry.witness_hash = this.witness.record('assistant_response', response, assistantEntry.id);
    this._persistWitness();
    this.memory.appendLog(assistantEntry);

    // 10.5. Record safety outcome if we had a safety token
    if (safetyToken) {
      await this.safetyGate.recordOutcome(safetyToken, true);
    }

    // 11. Feed SONA trajectory with response and end turn
    try {
      // Reward based on response length and intent match as a simple heuristic
      const reward = Math.min(1.0, 0.5 + (response.length > 50 ? 0.2 : 0) + (intentResult.score > 0.5 ? 0.1 : 0));
      this.learning.addStep(response, reward);
      this.learning.endTurn(reward);
    } catch {
      // Learning feedback non-fatal
    }

    // 12. Background SONA tick
    try {
      this.learning.tick();
    } catch {
      // Non-fatal
    }

    return response;
  }

  private buildSystemPrompt(
    context: Context,
    intent: IntentName,
    semanticContext: string,
    patternContext: string,
  ): string {
    const contextPrompt = this.contextMgr.systemPromptFor(context);
    const memoryCount = this.memory.count(context);

    const intentHint = intent !== 'general-chat'
      ? `\nDetected intent: ${intent}. Tailor your response accordingly.`
      : '';

    return `You are Ark Home, a persistent AI assistant that never forgets. You manage the user's ${context} life through one continuous conversation.

${contextPrompt}

You currently have ${memoryCount} memories in the ${context} context.${intentHint}${semanticContext}${patternContext}

Key behaviors:
- Remember everything from past conversations. Reference specifics when relevant.
- When proposing actions (scheduling, invoicing, messaging), list them clearly and ask for confirmation.
- Be direct, warm, and practical. Your user is busy. No fluff.
- If you're unsure about something, say so. Don't guess.
- Always indicate your confidence level for factual claims.`;
  }

  private async callLLM(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    if (!this.claude) {
      return 'No AI service configured. Set ANTHROPIC_API_KEY to enable Claude, or configure a local LLM.';
    }

    const response = await this.claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages.length > 0 ? messages : [{ role: 'user', content: '(empty conversation)' }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock?.text ?? '(no response)';
  }

  // Search conversation history (now with semantic search)
  search(query: string, context?: Context): ConversationEntry[] {
    return this.memory.searchLiteral(query, context);
  }

  // Async combined search (literal + semantic)
  async searchCombined(query: string, context?: Context) {
    return this.memory.searchCombined(query, context);
  }

  // Get memory stats (extended with RuVector stats)
  stats(): {
    total: number;
    personal: number;
    business: number;
    home: number;
    sona?: SonaStats;
    routerIntents?: number;
    rvfReady?: boolean;
  } {
    let sonaStats: SonaStats | undefined;
    try {
      const s = this.learning.getStats();
      sonaStats = {
        trajectoriesRecorded: s.trajectoriesRecorded,
        patternsLearned: s.patternsLearned,
        microLoraUpdates: s.microLoraUpdates,
        baseLoraUpdates: s.baseLoraUpdates,
        avgLearningTimeMs: s.avgLearningTimeMs,
      };
    } catch {
      // stats not available
    }

    let routerIntents: number | undefined;
    try {
      routerIntents = this.router.getIntents().length;
    } catch {
      // router not available
    }

    return {
      total: this.memory.count(),
      personal: this.memory.count('personal'),
      business: this.memory.count('business'),
      home: this.memory.count('home'),
      sona: sonaStats,
      routerIntents,
      rvfReady: this.initialized,
    };
  }
}

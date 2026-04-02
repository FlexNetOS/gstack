// Ark Home — SONA Learning Engine
// Wraps @ruvector/sona for trajectory-based learning.
// Every conversation turn is a trajectory: begin -> step -> end.
// Learned patterns are retrieved for context enrichment.

import { SonaEngine, type JsSonaConfig, type JsLearnedPattern } from '@ruvector/sona';
import { embedText, EMBEDDING_DIM } from './embedding';
import type { SonaStats } from './types';

export interface LearningConfig {
  hiddenDim: number;
  patternClusters?: number;
  trajectoryCapacity?: number;
  qualityThreshold?: number;
}

const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  hiddenDim: EMBEDDING_DIM, // 384, matching embedding dimension
  patternClusters: 50,
  trajectoryCapacity: 10000,
  qualityThreshold: 0.5,
};

export class LearningEngine {
  private sona: SonaEngine;
  private activeTrajectoryId: number | null = null;
  private turnCount = 0;
  private totalLearningTimeMs = 0;

  constructor(config?: Partial<LearningConfig>) {
    const cfg = { ...DEFAULT_LEARNING_CONFIG, ...config };
    const sonaConfig: JsSonaConfig = {
      hiddenDim: cfg.hiddenDim,
      embeddingDim: cfg.hiddenDim,
      microLoraRank: 1,
      baseLoraRank: 8,
      microLoraLr: 0.001,
      baseLoraLr: 0.0001,
      ewcLambda: 1000.0,
      patternClusters: cfg.patternClusters ?? 50,
      trajectoryCapacity: cfg.trajectoryCapacity ?? 10000,
      qualityThreshold: cfg.qualityThreshold ?? 0.5,
      backgroundIntervalMs: 300000, // 5 min
      enableSimd: true,
    };
    this.sona = SonaEngine.withConfig(sonaConfig);
  }

  /**
   * Begin a trajectory for a new user turn.
   * Returns the trajectory ID for tracking.
   */
  beginTurn(userInput: string, context: string): number {
    const embedding = embedText(userInput);
    // SonaEngine expects Array<number>
    const embeddingArray = Array.from(embedding);
    const trajId = this.sona.beginTrajectory(embeddingArray);
    this.activeTrajectoryId = trajId;

    // Tag trajectory with context namespace
    this.sona.addTrajectoryContext(trajId, context);

    return trajId;
  }

  /**
   * Add a step to the active trajectory.
   * Called after the LLM responds — activations simulate the response embedding,
   * attention weights simulate relevance, reward reflects response quality.
   */
  addStep(responseText: string, reward: number = 0.7): void {
    if (this.activeTrajectoryId === null) return;

    const activations = Array.from(embedText(responseText));
    // Attention weights: uniform for now, could be refined with actual attention data
    const attentionWeights = new Array(activations.length).fill(1.0 / activations.length);

    this.sona.addTrajectoryStep(
      this.activeTrajectoryId,
      activations,
      attentionWeights,
      reward,
    );
  }

  /**
   * Set the model route for the current trajectory (e.g., which intent was matched).
   */
  setRoute(route: string): void {
    if (this.activeTrajectoryId === null) return;
    this.sona.setTrajectoryRoute(this.activeTrajectoryId, route);
  }

  /**
   * End the current trajectory and submit for learning.
   * Quality is a 0-1 score. Call this after the full turn completes.
   */
  endTurn(quality: number = 0.7): number | null {
    if (this.activeTrajectoryId === null) return null;
    const trajId = this.activeTrajectoryId;
    const start = performance.now();

    this.sona.endTrajectory(trajId, quality);

    this.totalLearningTimeMs += performance.now() - start;
    this.turnCount++;
    this.activeTrajectoryId = null;

    return trajId;
  }

  /**
   * Find learned patterns similar to the given text.
   * Used to enrich context before calling the LLM.
   */
  findPatterns(text: string, k: number = 5): JsLearnedPattern[] {
    const embedding = Array.from(embedText(text));
    return this.sona.findPatterns(embedding, k);
  }

  /**
   * Run a background learning tick. Call periodically.
   */
  tick(): string | null {
    return this.sona.tick();
  }

  /**
   * Force an immediate learning cycle.
   */
  forceLearn(): string {
    return this.sona.forceLearn();
  }

  /**
   * Get SONA engine stats.
   */
  getStats(): SonaStats & { raw: string } {
    const raw = this.sona.getStats();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      // stats may not be valid JSON in all versions
    }

    return {
      trajectoriesRecorded: this.turnCount,
      patternsLearned: (parsed.patterns_learned as number) ?? 0,
      microLoraUpdates: (parsed.micro_lora_updates as number) ?? 0,
      baseLoraUpdates: (parsed.base_lora_updates as number) ?? 0,
      avgLearningTimeMs: this.turnCount > 0 ? this.totalLearningTimeMs / this.turnCount : 0,
      raw,
    };
  }

  /**
   * Apply micro-LoRA transformation to an embedding.
   * Useful for adapting embeddings based on learned patterns.
   */
  transform(embedding: Float32Array): Float32Array {
    const input = Array.from(embedding);
    const output = this.sona.applyMicroLora(input);
    return new Float32Array(output);
  }
}

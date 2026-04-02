// Ark Home — Safety Gate (Cognitum Gate integration)
// Wraps @cognitum/gate for action-level permit/defer/deny decisions.
// Falls back to a permissive stub if the package is unavailable.

interface SafetyCheckResult {
  permitted: boolean;
  confidence: number;
  reason: string;
  token?: string;
}

interface SafetyStats {
  available: boolean;
  actionsChecked: number;
  actionsBlocked: number;
}

// Action keywords that trigger a safety check before LLM call
const ACTION_KEYWORDS = [
  'schedule', 'scheduling', 'calendar', 'appointment', 'meeting', 'remind',
  'invoice', 'invoicing', 'payment', 'bill', 'charge', 'transfer',
  'send', 'email', 'message', 'notify', 'post', 'publish',
  'delete', 'remove', 'cancel', 'terminate',
  'order', 'purchase', 'buy', 'subscribe',
  'deploy', 'ship', 'release', 'push',
];

export class SafetyGate {
  private gate: any = null;
  private ready = false;
  private actionsChecked = 0;
  private actionsBlocked = 0;

  async init(): Promise<void> {
    try {
      const mod = await import('@cognitum/gate');
      const CognitumGate = mod.CognitumGate ?? mod.default;
      if (CognitumGate?.init) {
        this.gate = await CognitumGate.init({
          tileCount: 2,
          coherenceThreshold: 0.7,
          runtime: 'bun' as any,
        });
        this.ready = true;
      }
    } catch {
      // @cognitum/gate not available — use permissive stub
      this.gate = null;
      this.ready = false;
    }
  }

  /**
   * Returns true if the input text looks like it involves a real-world action
   * (scheduling, invoicing, sending, deleting, etc.)
   */
  isActionIntent(input: string): boolean {
    const lower = input.toLowerCase();
    return ACTION_KEYWORDS.some(kw => lower.includes(kw));
  }

  /**
   * Check whether an action should be permitted.
   * If the real gate is available, delegates to CognitumGate.permitAction().
   * Otherwise, returns a permissive stub result.
   */
  async checkAction(description: string, context: string): Promise<SafetyCheckResult> {
    this.actionsChecked++;

    if (!this.gate) {
      // Stub: always permit, low confidence
      return {
        permitted: true,
        confidence: 0.5,
        reason: 'Safety gate unavailable — defaulting to permit',
      };
    }

    try {
      const result = await this.gate.permitAction({
        agentId: 'ark-home',
        action: description,
        target: context,
        context: { source: 'conversation', context },
        priority: 'normal',
        timeoutMs: 3000,
      });

      const permitted = result.verdict === 'permit';
      if (!permitted) {
        this.actionsBlocked++;
      }

      return {
        permitted,
        confidence: result.coherenceScore,
        reason: result.reason ?? (permitted ? 'Action permitted by Cognitum Gate' : `Action ${result.verdict}: coherence too low`),
        token: result.token,
      };
    } catch (err) {
      // Gate error — fail open (permit) but flag it
      return {
        permitted: true,
        confidence: 0.3,
        reason: `Safety gate error: ${err instanceof Error ? err.message : 'unknown'} — defaulting to permit`,
      };
    }
  }

  /**
   * Record the outcome of a permitted action (feeds back into coherence scoring).
   */
  async recordOutcome(token: string, success: boolean): Promise<void> {
    if (!this.gate || !token) return;

    try {
      await this.gate.recordOutcome(token, {
        success,
        durationMs: 0,
      });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Return current safety gate statistics.
   */
  stats(): SafetyStats {
    return {
      available: this.ready,
      actionsChecked: this.actionsChecked,
      actionsBlocked: this.actionsBlocked,
    };
  }

  /**
   * Destroy the gate and release resources.
   */
  async destroy(): Promise<void> {
    if (this.gate?.destroy) {
      try {
        await this.gate.destroy();
      } catch {
        // Non-fatal
      }
    }
    this.gate = null;
    this.ready = false;
  }
}

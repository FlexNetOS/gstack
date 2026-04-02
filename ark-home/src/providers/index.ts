// Ark Home — Resource Provider Framework
// Plugin interface for resource providers (fs, docker, network, etc.)

export interface ProviderAction {
  name: string;
  description: string;
  destructive: boolean;
}

export interface ProviderInfo {
  name: string;
  description: string;
  available: boolean;
  actions: ProviderAction[];
}

export interface ProviderHealth {
  available: boolean;
  details?: string;
}

export interface ResourceProvider {
  readonly name: string;
  readonly description: string;

  /** Initialize the provider. Returns false if the resource is unavailable. */
  init(): Promise<boolean>;

  /** List available actions. */
  actions(): ProviderAction[];

  /** Execute an action. Throws on error. */
  execute(action: string, args: Record<string, unknown>): Promise<unknown>;

  /** Health check. */
  health(): Promise<ProviderHealth>;
}

export class ResourceRegistry {
  private providers = new Map<string, ResourceProvider>();

  register(provider: ResourceProvider): void {
    this.providers.set(provider.name, provider);
  }

  async initAll(): Promise<void> {
    for (const [name, provider] of this.providers) {
      try {
        const ok = await provider.init();
        if (!ok) {
          console.error(`[ark-home] Provider "${name}" unavailable — skipping`);
        }
      } catch (err) {
        console.error(`[ark-home] Provider "${name}" init failed:`, err);
      }
    }
  }

  list(): ProviderInfo[] {
    const result: ProviderInfo[] = [];
    for (const provider of this.providers.values()) {
      result.push({
        name: provider.name,
        description: provider.description,
        available: true,
        actions: provider.actions(),
      });
    }
    return result;
  }

  async execute(providerName: string, action: string, args: Record<string, unknown>): Promise<unknown> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerName}`);
    }
    return provider.execute(action, args);
  }

  async healthAll(): Promise<Record<string, ProviderHealth>> {
    const result: Record<string, ProviderHealth> = {};
    for (const [name, provider] of this.providers) {
      try {
        result[name] = await provider.health();
      } catch {
        result[name] = { available: false, details: 'health check failed' };
      }
    }
    return result;
  }

  get(name: string): ResourceProvider | undefined {
    return this.providers.get(name);
  }
}

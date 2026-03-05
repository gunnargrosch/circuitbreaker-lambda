import type { CircuitBreakerState, StateProvider } from "./types.js";

interface CacheEntry {
  state: CircuitBreakerState;
  fetchedAt: number;
}

export class CachedProvider implements StateProvider {
  private readonly provider: StateProvider;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(provider: StateProvider, ttlMs: number) {
    this.provider = provider;
    this.ttlMs = ttlMs;
  }

  async getState(circuitId: string): Promise<CircuitBreakerState | undefined> {
    const entry = this.cache.get(circuitId);
    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) {
      return { ...entry.state };
    }

    const state = await this.provider.getState(circuitId);
    if (state) {
      this.cache.set(circuitId, { state: { ...state }, fetchedAt: Date.now() });
    }
    return state;
  }

  async saveState(circuitId: string, state: CircuitBreakerState): Promise<void> {
    this.cache.set(circuitId, { state: { ...state }, fetchedAt: Date.now() });
    await this.provider.saveState(circuitId, state);
  }
}

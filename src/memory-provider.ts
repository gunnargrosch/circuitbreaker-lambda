import type { CircuitBreakerState, StateProvider } from "./types.js";

export class MemoryProvider implements StateProvider {
  private readonly store = new Map<string, CircuitBreakerState>();

  async getState(circuitId: string): Promise<CircuitBreakerState | undefined> {
    const state = this.store.get(circuitId);
    return state ? { ...state } : undefined;
  }

  async saveState(circuitId: string, state: CircuitBreakerState): Promise<void> {
    this.store.set(circuitId, { ...state });
  }

  clear(): void {
    this.store.clear();
  }
}

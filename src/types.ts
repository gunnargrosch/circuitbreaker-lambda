export type CircuitState = "CLOSED" | "OPEN" | "HALF-OPEN";

export interface CircuitBreakerState {
  circuitState: CircuitState;
  failureCount: number;
  successCount: number;
  nextAttempt: number;
  lastFailureTime: number;
  consecutiveOpens: number;
  stateTimestamp: number;
  /**
   * Schema version for cross-runtime compatibility. A future Lambda Extension
   * (Rust/Go) will share the same DynamoDB table and use this field to detect
   * incompatible state records. Currently always 1.
   */
  schemaVersion: number;
}

export interface StateProvider {
  getState(circuitId: string): Promise<CircuitBreakerState | undefined>;
  saveState(circuitId: string, state: CircuitBreakerState): Promise<void>;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  successThreshold?: number;
  timeout?: number;
  maxTimeout?: number;
  windowDuration?: number;
  fallback?: (() => Promise<unknown>) | null;
  stateProvider?: StateProvider;
  circuitId?: string;
  cacheTtlMs?: number;
  tableName?: string;
}

export const DEFAULTS = {
  failureThreshold: 5,
  successThreshold: 2,
  timeout: 10000,
  maxTimeout: 60000,
  windowDuration: 60000,
  cacheTtlMs: 0,
  schemaVersion: 1,
} as const;

export function createInitialState(): CircuitBreakerState {
  return {
    circuitState: "CLOSED",
    failureCount: 0,
    successCount: 0,
    nextAttempt: 0,
    lastFailureTime: 0,
    consecutiveOpens: 0,
    stateTimestamp: Date.now(),
    schemaVersion: DEFAULTS.schemaVersion,
  };
}

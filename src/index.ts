import { CachedProvider } from "./cache.js";
import { DynamoDBProvider } from "./dynamodb-provider.js";
import {
  DEFAULTS,
  createInitialState,
  type CircuitBreakerOptions,
  type CircuitBreakerState,
  type StateProvider,
} from "./types.js";

export type { CircuitBreakerOptions, CircuitBreakerState, CircuitState, StateProvider } from "./types.js";
export { DynamoDBProvider, type DynamoDBProviderOptions } from "./dynamodb-provider.js";
export { MemoryProvider } from "./memory-provider.js";
export { CachedProvider } from "./cache.js";

function log(level: "info" | "warn", fields: Record<string, unknown>): void {
  const method = level === "warn" ? console.warn : console.log;
  method(JSON.stringify({ source: "circuitbreaker-lambda", level, ...fields }));
}

export class CircuitBreaker {
  private readonly request: (() => Promise<unknown>) | null;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;
  private readonly maxTimeout: number;
  private readonly windowDuration: number;
  private readonly fallback: (() => Promise<unknown>) | null;
  private readonly circuitId: string;
  private readonly provider: StateProvider;

  private state: CircuitBreakerState;
  private stateLoaded = false;

  constructor(request: (() => Promise<unknown>) | null, options: CircuitBreakerOptions = {}) {
    this.request = request;
    this.failureThreshold = options.failureThreshold ?? DEFAULTS.failureThreshold;
    this.successThreshold = options.successThreshold ?? DEFAULTS.successThreshold;
    this.timeout = options.timeout ?? DEFAULTS.timeout;
    this.maxTimeout = options.maxTimeout ?? DEFAULTS.maxTimeout;
    this.windowDuration = options.windowDuration ?? DEFAULTS.windowDuration;
    this.fallback = options.fallback ?? null;
    this.circuitId = options.circuitId ?? process.env.AWS_LAMBDA_FUNCTION_NAME ?? "";

    if (!this.circuitId) {
      throw new Error(
        "Circuit ID is required. Set AWS_LAMBDA_FUNCTION_NAME env var or pass circuitId option.",
      );
    }

    const tableName = options.tableName ?? process.env.CIRCUITBREAKER_TABLE ?? "";

    let base: StateProvider;
    if (options.stateProvider) {
      if (tableName) {
        log("warn", { message: "tableName is ignored when stateProvider is set" });
      }
      base = options.stateProvider;
    } else {
      if (!tableName) {
        throw new Error(
          "Circuit breaker table name is required. Set CIRCUITBREAKER_TABLE env var or pass tableName option.",
        );
      }
      base = new DynamoDBProvider({ tableName });
    }

    const cacheTtlMs = options.cacheTtlMs ?? DEFAULTS.cacheTtlMs;
    this.provider = cacheTtlMs > 0 ? new CachedProvider(base, cacheTtlMs) : base;

    this.state = createInitialState();
  }

  /**
   * Execute the wrapped function through the circuit breaker.
   * Loads state, checks the circuit, calls the function, and records the outcome.
   */
  async fire(): Promise<unknown> {
    if (!this.request) {
      throw new Error("CircuitBreaker: no request function provided. Use check/recordSuccess/recordFailure instead.");
    }

    const allowed = await this.check();
    if (!allowed) {
      if (this.fallback) return this.fallback();
      throw new Error("CircuitBreaker state: OPEN");
    }

    try {
      const response = await this.request();
      await this.recordSuccess();
      return response;
    } catch (err) {
      await this.recordFailure();
      if (this.fallback) return this.fallback();
      throw err;
    }
  }

  /**
   * Check whether the circuit allows a request.
   * Loads state from the provider and transitions OPEN->HALF if timeout expired.
   * Returns true if the request should proceed, false if the circuit is OPEN.
   */
  async check(): Promise<boolean> {
    this.stateLoaded = false;
    await this.loadState();
    this.stateLoaded = true;
    this.applyWindowReset();

    if (this.state.circuitState === "OPEN") {
      if (this.state.nextAttempt <= Date.now()) {
        log("info", {
          action: "transition",
          circuitId: this.circuitId,
          from: "OPEN",
          to: "HALF-OPEN",
        });
        this.toHalf();
        await this.persistState();
        return true;
      }
      log("info", {
        action: "blocked",
        circuitId: this.circuitId,
        state: "OPEN",
        nextAttempt: this.state.nextAttempt,
      });
      return false;
    }
    return true;
  }

  /** Record a successful request outcome. Must be called after check() in the same invocation. */
  async recordSuccess(): Promise<void> {
    if (!this.stateLoaded) {
      throw new Error("CircuitBreaker: recordSuccess() called without a preceding check()");
    }
    if (this.state.circuitState === "HALF-OPEN") {
      this.state.successCount++;
      if (this.state.successCount >= this.successThreshold) {
        log("info", {
          action: "transition",
          circuitId: this.circuitId,
          from: "HALF-OPEN",
          to: "CLOSED",
        });
        this.toClosed();
      }
    }
    this.state.stateTimestamp = Date.now();
    await this.persistState();
  }

  /** Record a failed request outcome. Must be called after check() in the same invocation. */
  async recordFailure(): Promise<void> {
    if (!this.stateLoaded) {
      throw new Error("CircuitBreaker: recordFailure() called without a preceding check()");
    }
    this.state.failureCount++;
    this.state.lastFailureTime = Date.now();

    if (this.state.circuitState === "HALF-OPEN") {
      log("info", {
        action: "transition",
        circuitId: this.circuitId,
        from: "HALF-OPEN",
        to: "OPEN",
        consecutiveOpens: this.state.consecutiveOpens + 1,
      });
      this.toOpen();
    } else if (this.state.failureCount >= this.failureThreshold) {
      log("info", {
        action: "transition",
        circuitId: this.circuitId,
        from: this.state.circuitState,
        to: "OPEN",
        failureCount: this.state.failureCount,
        failureThreshold: this.failureThreshold,
      });
      this.toOpen();
    }

    this.state.stateTimestamp = Date.now();
    await this.persistState();
  }

  private async loadState(): Promise<void> {
    try {
      const record = await this.provider.getState(this.circuitId);
      if (record) {
        // Normalize legacy "HALF" state written by older versions
        const circuitState = (record.circuitState as string) === "HALF" ? "HALF-OPEN" : record.circuitState;
        this.state = { ...record, circuitState };
      }
    } catch (err) {
      log("warn", { action: "getState", circuitId: this.circuitId, error: String(err) });
    }
  }

  private applyWindowReset(): void {
    if (
      this.state.circuitState === "CLOSED" &&
      this.state.lastFailureTime > 0 &&
      Date.now() - this.state.lastFailureTime > this.windowDuration
    ) {
      this.state.failureCount = 0;
    }
  }

  private async persistState(): Promise<void> {
    try {
      await this.provider.saveState(this.circuitId, this.state);
    } catch (err) {
      log("warn", { action: "saveState", circuitId: this.circuitId, error: String(err) });
    }
  }

  /**
   * Exponential backoff only applies to consecutive HALF->OPEN transitions.
   * CLOSED->OPEN always uses the base timeout since the downstream service
   * may have recovered between independent failure episodes.
   */
  private toOpen(): void {
    const wasHalf = this.state.circuitState === "HALF-OPEN";
    this.state.circuitState = "OPEN";

    if (wasHalf) {
      this.state.consecutiveOpens++;
    } else {
      this.state.consecutiveOpens = 0;
    }

    const backoff = Math.min(
      this.timeout * Math.pow(2, this.state.consecutiveOpens),
      this.maxTimeout,
    );
    this.state.nextAttempt = Date.now() + backoff;
  }

  private toClosed(): void {
    this.state.circuitState = "CLOSED";
    this.state.successCount = 0;
    this.state.failureCount = 0;
    this.state.consecutiveOpens = 0;
  }

  private toHalf(): void {
    this.state.circuitState = "HALF-OPEN";
    this.state.successCount = 0;
  }
}

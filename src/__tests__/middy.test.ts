import { describe, it, expect, vi, beforeEach } from "vitest";
import { circuitBreakerMiddleware } from "../middy.js";
import { MemoryProvider } from "../memory-provider.js";
import { createInitialState } from "../types.js";

let provider: MemoryProvider;

beforeEach(() => {
  provider = new MemoryProvider();
});

function createMiddleware(options: Record<string, unknown> = {}) {
  return circuitBreakerMiddleware({
    stateProvider: provider,
    circuitId: "test-circuit",
    ...options,
  });
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    event: {},
    context: {},
    response: undefined,
    error: undefined,
    ...overrides,
  };
}

describe("circuitBreakerMiddleware", () => {
  it("should allow request through when circuit is CLOSED", async () => {
    const mw = createMiddleware();
    const request = makeRequest();

    const result = await mw.before(request);

    expect(result).toBeUndefined();
  });

  it("should record success and transition HALF-OPEN toward CLOSED", async () => {
    await provider.saveState("test-circuit", {
      ...createInitialState(),
      circuitState: "HALF-OPEN",
      successCount: 0,
    });
    const mw = createMiddleware({ successThreshold: 2 });
    const request = makeRequest();

    await mw.before(request);
    await mw.after(request);

    const state = await provider.getState("test-circuit");
    expect(state?.successCount).toBe(1);
    expect(state?.circuitState).toBe("HALF-OPEN");
  });

  it("should record failure and rethrow on onError", async () => {
    const mw = createMiddleware({ failureThreshold: 1 });
    const request = makeRequest({ error: new Error("handler failed") });

    await mw.before(request);
    await expect(mw.onError(request)).rejects.toThrow("handler failed");

    const state = await provider.getState("test-circuit");
    expect(state?.circuitState).toBe("OPEN");
  });

  it("should not swallow errors -- onError always rethrows", async () => {
    const mw = createMiddleware();
    const request = makeRequest({ error: new Error("important error") });

    await mw.before(request);
    await expect(mw.onError(request)).rejects.toThrow("important error");
  });

  it("should short-circuit with fallback when circuit is OPEN", async () => {
    await provider.saveState("test-circuit", {
      ...createInitialState(),
      circuitState: "OPEN",
      nextAttempt: Date.now() + 60000,
    });
    const fallback = vi.fn().mockResolvedValue({ statusCode: 503, body: "fallback" });
    const mw = createMiddleware({ fallback });
    const request = makeRequest();

    const result = await mw.before(request);

    expect(result).toEqual({ statusCode: 503, body: "fallback" });
    expect(request.response).toEqual({ statusCode: 503, body: "fallback" });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("should throw when circuit is OPEN and no fallback", async () => {
    await provider.saveState("test-circuit", {
      ...createInitialState(),
      circuitState: "OPEN",
      nextAttempt: Date.now() + 60000,
    });
    const mw = createMiddleware();
    const request = makeRequest();

    await expect(mw.before(request)).rejects.toThrow("CircuitBreaker state: OPEN");
  });

  it("should open circuit after repeated handler failures", async () => {
    const mw = createMiddleware({ failureThreshold: 2 });

    for (let i = 0; i < 2; i++) {
      const request = makeRequest({ error: new Error("fail") });
      await mw.before(request);
      try { await mw.onError(request); } catch { /* expected */ }
    }

    const state = await provider.getState("test-circuit");
    expect(state?.circuitState).toBe("OPEN");
  });

  it("should reuse the same breaker across invocations", async () => {
    const mw = createMiddleware({ failureThreshold: 3 });

    // Two failures across separate "invocations"
    for (let i = 0; i < 2; i++) {
      const request = makeRequest({ error: new Error("fail") });
      await mw.before(request);
      try { await mw.onError(request); } catch { /* expected */ }
    }

    const state = await provider.getState("test-circuit");
    expect(state?.failureCount).toBe(2);
    expect(state?.circuitState).toBe("CLOSED");
  });

  it("should not pass fallback to CircuitBreaker constructor", async () => {
    // Fallback should only be used by the middleware directly, not stored in the breaker
    const fallback = vi.fn().mockResolvedValue("fallback");
    const mw = createMiddleware({ fallback });
    const request = makeRequest();

    // Circuit is closed, so before should allow through (not call fallback)
    await mw.before(request);
    expect(fallback).not.toHaveBeenCalled();
  });
});

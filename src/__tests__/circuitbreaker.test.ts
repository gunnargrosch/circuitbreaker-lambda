import { describe, it, expect, vi, beforeEach } from "vitest";
import { CircuitBreaker } from "../index.js";
import { MemoryProvider } from "../memory-provider.js";
import type { StateProvider } from "../types.js";
import { createInitialState } from "../types.js";

let provider: MemoryProvider;

beforeEach(() => {
  provider = new MemoryProvider();
});

function createBreaker(
  request: (() => Promise<unknown>) | null,
  options: Record<string, unknown> = {},
) {
  return new CircuitBreaker(request, {
    stateProvider: provider,
    circuitId: "test-circuit",
    ...options,
  });
}

describe("CircuitBreaker", () => {
  describe("basic operation", () => {
    it("should call request and return response on success", async () => {
      const request = vi.fn().mockResolvedValue({ data: "ok" });
      const cb = createBreaker(request);

      const result = await cb.fire();

      expect(result).toEqual({ data: "ok" });
      expect(request).toHaveBeenCalledOnce();
    });

    it("should throw on failure when no fallback configured", async () => {
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request);

      await expect(cb.fire()).rejects.toThrow("fail");
    });

    it("should use fallback on failure when configured", async () => {
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const fallback = vi.fn().mockResolvedValue({ data: "fallback" });
      const cb = createBreaker(request, { fallback });

      const result = await cb.fire();

      expect(result).toEqual({ data: "fallback" });
    });

    it("should throw when circuitId is empty", () => {
      expect(
        () => new CircuitBreaker(vi.fn(), { stateProvider: provider, circuitId: "" }),
      ).toThrow("Circuit ID is required");
    });

    it("should throw when fire() called without request function", async () => {
      const cb = createBreaker(null);

      await expect(cb.fire()).rejects.toThrow("no request function provided");
    });

    it("should warn when tableName and stateProvider are both set", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      new CircuitBreaker(vi.fn(), {
        stateProvider: provider,
        tableName: "some-table",
        circuitId: "test",
      });

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain("tableName is ignored");
    });
  });

  describe("state transitions", () => {
    it("should open circuit after reaching failure threshold", async () => {
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, { failureThreshold: 3 });

      for (let i = 0; i < 3; i++) {
        await expect(cb.fire()).rejects.toThrow("fail");
      }

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("OPEN");
    });

    it("should throw when circuit is OPEN and no fallback", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "OPEN",
        nextAttempt: Date.now() + 60000,
      });
      const request = vi.fn();
      const cb = createBreaker(request);

      await expect(cb.fire()).rejects.toThrow("CircuitBreaker state: OPEN");
      expect(request).not.toHaveBeenCalled();
    });

    it("should use fallback when circuit is OPEN", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "OPEN",
        nextAttempt: Date.now() + 60000,
      });
      const request = vi.fn();
      const fallback = vi.fn().mockResolvedValue("fallback");
      const cb = createBreaker(request, { fallback });

      const result = await cb.fire();

      expect(result).toBe("fallback");
      expect(request).not.toHaveBeenCalled();
    });

    it("should transition from OPEN to HALF when timeout expires", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "OPEN",
        nextAttempt: Date.now() - 1000,
      });
      const request = vi.fn().mockResolvedValue("ok");
      const cb = createBreaker(request);

      await cb.fire();

      expect(request).toHaveBeenCalledOnce();
    });

    it("should transition from HALF to CLOSED after success threshold", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "HALF",
        successCount: 1,
      });
      const request = vi.fn().mockResolvedValue("ok");
      const cb = createBreaker(request, { successThreshold: 2 });

      await cb.fire();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("CLOSED");
      expect(state?.failureCount).toBe(0);
      expect(state?.successCount).toBe(0);
      expect(state?.consecutiveOpens).toBe(0);
    });

    it("should immediately reopen on single failure in HALF state", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "HALF",
      });
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request);

      await expect(cb.fire()).rejects.toThrow("fail");

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("OPEN");
    });
  });

  describe("check/recordSuccess/recordFailure API", () => {
    it("should return true when circuit is CLOSED", async () => {
      const cb = createBreaker(null);

      const allowed = await cb.check();

      expect(allowed).toBe(true);
    });

    it("should return false when circuit is OPEN", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "OPEN",
        nextAttempt: Date.now() + 60000,
      });
      const cb = createBreaker(null);

      const allowed = await cb.check();

      expect(allowed).toBe(false);
    });

    it("should transition OPEN->HALF and return true when timeout expired", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "OPEN",
        nextAttempt: Date.now() - 1000,
      });
      const cb = createBreaker(null);

      const allowed = await cb.check();

      expect(allowed).toBe(true);
    });

    it("should record success and transition HALF->CLOSED", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "HALF",
        successCount: 1,
      });
      const cb = createBreaker(null, { successThreshold: 2 });

      await cb.check();
      await cb.recordSuccess();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("CLOSED");
    });

    it("should record failure and transition HALF->OPEN", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "HALF",
      });
      const cb = createBreaker(null);

      await cb.check();
      await cb.recordFailure();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("OPEN");
    });
  });

  describe("failure counting", () => {
    it("should not reset failure count on success in CLOSED state", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        failureCount: 3,
        lastFailureTime: Date.now(),
      });
      const request = vi.fn().mockResolvedValue("ok");
      const cb = createBreaker(request, { failureThreshold: 5 });

      await cb.fire();

      const state = await provider.getState("test-circuit");
      expect(state?.failureCount).toBe(3);
    });

    it("should open circuit with alternating success/failure pattern", async () => {
      const request = vi.fn();
      const cb = createBreaker(request, { failureThreshold: 3 });

      request.mockRejectedValueOnce(new Error("fail"));
      await expect(cb.fire()).rejects.toThrow();

      request.mockResolvedValueOnce("ok");
      await cb.fire();

      request.mockRejectedValueOnce(new Error("fail"));
      await expect(cb.fire()).rejects.toThrow();

      request.mockResolvedValueOnce("ok");
      await cb.fire();

      request.mockRejectedValueOnce(new Error("fail"));
      await expect(cb.fire()).rejects.toThrow();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("OPEN");
    });
  });

  describe("exponential backoff", () => {
    it("should use base timeout on first open", async () => {
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, {
        failureThreshold: 1,
        timeout: 5000,
      });
      const before = Date.now();

      await expect(cb.fire()).rejects.toThrow();

      const state = await provider.getState("test-circuit");
      expect(state?.consecutiveOpens).toBe(0);
      expect(state?.nextAttempt).toBeGreaterThanOrEqual(before + 5000);
      expect(state?.nextAttempt).toBeLessThanOrEqual(before + 5100);
    });

    it("should double timeout on consecutive reopens from HALF", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "HALF",
        consecutiveOpens: 0,
      });
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, { timeout: 5000 });
      const before = Date.now();

      await expect(cb.fire()).rejects.toThrow();

      const state = await provider.getState("test-circuit");
      expect(state?.consecutiveOpens).toBe(1);
      expect(state?.nextAttempt).toBeGreaterThanOrEqual(before + 10000);
    });

    it("should not apply backoff on repeated CLOSED->OPEN transitions", async () => {
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, {
        failureThreshold: 1,
        timeout: 5000,
      });

      await expect(cb.fire()).rejects.toThrow();
      let state = await provider.getState("test-circuit");
      expect(state?.consecutiveOpens).toBe(0);

      await provider.saveState("test-circuit", createInitialState());
      const before = Date.now();
      await expect(cb.fire()).rejects.toThrow();

      state = await provider.getState("test-circuit");
      expect(state?.consecutiveOpens).toBe(0);
      expect(state?.nextAttempt).toBeLessThanOrEqual(before + 5100);
    });

    it("should cap timeout at maxTimeout", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "HALF",
        consecutiveOpens: 10,
      });
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, {
        timeout: 5000,
        maxTimeout: 30000,
      });
      const before = Date.now();

      await expect(cb.fire()).rejects.toThrow();

      const state = await provider.getState("test-circuit");
      expect(state?.nextAttempt).toBeLessThanOrEqual(before + 30100);
    });

    it("should reset consecutiveOpens when circuit closes", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        circuitState: "HALF",
        successCount: 1,
        consecutiveOpens: 3,
      });
      const request = vi.fn().mockResolvedValue("ok");
      const cb = createBreaker(request, { successThreshold: 2 });

      await cb.fire();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("CLOSED");
      expect(state?.consecutiveOpens).toBe(0);
    });
  });

  describe("window-based failure reset", () => {
    it("should reset failure count when window expires", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        failureCount: 4,
        lastFailureTime: Date.now() - 120000,
      });
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, {
        failureThreshold: 5,
        windowDuration: 60000,
      });

      await expect(cb.fire()).rejects.toThrow();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("CLOSED");
      expect(state?.failureCount).toBe(1);
    });

    it("should not reset failure count within window", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        failureCount: 4,
        lastFailureTime: Date.now() - 1000,
      });
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, {
        failureThreshold: 5,
        windowDuration: 60000,
      });

      await expect(cb.fire()).rejects.toThrow();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("OPEN");
      expect(state?.failureCount).toBe(5);
    });

    it("should not reset when lastFailureTime is 0", async () => {
      await provider.saveState("test-circuit", {
        ...createInitialState(),
        failureCount: 4,
        lastFailureTime: 0,
      });
      const request = vi.fn().mockRejectedValue(new Error("fail"));
      const cb = createBreaker(request, { failureThreshold: 5 });

      await expect(cb.fire()).rejects.toThrow();

      const state = await provider.getState("test-circuit");
      expect(state?.circuitState).toBe("OPEN");
      expect(state?.failureCount).toBe(5);
    });
  });

  describe("fail open on provider errors", () => {
    it("should allow request through when getState fails", async () => {
      const failingProvider: StateProvider = {
        getState: vi.fn().mockRejectedValue(new Error("DynamoDB unavailable")),
        saveState: vi.fn().mockRejectedValue(new Error("DynamoDB unavailable")),
      };
      const request = vi.fn().mockResolvedValue({ data: "ok" });
      const cb = new CircuitBreaker(request, {
        stateProvider: failingProvider,
        circuitId: "test",
      });

      const result = await cb.fire();

      expect(result).toEqual({ data: "ok" });
      expect(request).toHaveBeenCalledOnce();
    });

    it("should return response even when saveState fails", async () => {
      const failingProvider: StateProvider = {
        getState: vi.fn().mockResolvedValue(undefined),
        saveState: vi.fn().mockRejectedValue(new Error("DynamoDB unavailable")),
      };
      const request = vi.fn().mockResolvedValue({ data: "ok" });
      const cb = new CircuitBreaker(request, {
        stateProvider: failingProvider,
        circuitId: "test",
      });

      const result = await cb.fire();

      expect(result).toEqual({ data: "ok" });
    });

    it("should log warnings on provider errors", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failingProvider: StateProvider = {
        getState: vi.fn().mockRejectedValue(new Error("connection timeout")),
        saveState: vi.fn().mockRejectedValue(new Error("connection timeout")),
      };
      const request = vi.fn().mockResolvedValue("ok");
      const cb = new CircuitBreaker(request, {
        stateProvider: failingProvider,
        circuitId: "test",
      });

      await cb.fire();

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[0][0]).toContain("getState");
      expect(warnSpy.mock.calls[1][0]).toContain("saveState");
    });
  });
});

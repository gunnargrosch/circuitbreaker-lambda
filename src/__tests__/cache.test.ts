import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CachedProvider } from "../cache.js";
import { MemoryProvider } from "../memory-provider.js";
import { createInitialState } from "../types.js";

let inner: MemoryProvider;
let cached: CachedProvider;

beforeEach(() => {
  vi.useFakeTimers();
  inner = new MemoryProvider();
  cached = new CachedProvider(inner, 500);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CachedProvider", () => {
  it("should pass through to inner provider on cache miss", async () => {
    const state = createInitialState();
    await inner.saveState("test", state);

    const result = await cached.getState("test");

    expect(result?.circuitState).toBe("CLOSED");
  });

  it("should return cached state within TTL", async () => {
    const state = createInitialState();
    await inner.saveState("test", state);

    await cached.getState("test");

    // Modify inner state directly
    const modified = createInitialState();
    modified.circuitState = "OPEN";
    await inner.saveState("test", modified);

    // Should still return cached CLOSED state
    const result = await cached.getState("test");
    expect(result?.circuitState).toBe("CLOSED");
  });

  it("should refresh from inner provider after TTL expires", async () => {
    const state = createInitialState();
    await inner.saveState("test", state);

    await cached.getState("test");

    // Modify inner state
    const modified = createInitialState();
    modified.circuitState = "OPEN";
    await inner.saveState("test", modified);

    // Advance time past TTL
    vi.advanceTimersByTime(600);

    const result = await cached.getState("test");
    expect(result?.circuitState).toBe("OPEN");
  });

  it("should update cache on saveState (write-through)", async () => {
    const state = createInitialState();
    state.circuitState = "OPEN";

    await cached.saveState("test", state);

    // Inner should have it
    const innerResult = await inner.getState("test");
    expect(innerResult?.circuitState).toBe("OPEN");

    // Cache should serve it without hitting inner again
    const spy = vi.spyOn(inner, "getState");
    const cachedResult = await cached.getState("test");
    expect(cachedResult?.circuitState).toBe("OPEN");
    expect(spy).not.toHaveBeenCalled();
  });

  it("should return undefined for unknown circuit", async () => {
    const result = await cached.getState("unknown");
    expect(result).toBeUndefined();
  });

  it("should return a copy so callers cannot corrupt the cache", async () => {
    const state = createInitialState();
    await cached.saveState("test", state);

    const result = await cached.getState("test");
    expect(result).toBeDefined();
    if (result) result.circuitState = "OPEN";

    const second = await cached.getState("test");
    expect(second?.circuitState).toBe("CLOSED");
  });

  it("should not share cache between instances", async () => {
    const state = createInitialState();
    state.circuitState = "OPEN";
    await cached.saveState("test", state);

    const otherCached = new CachedProvider(inner, 500);
    // Modify inner to CLOSED
    const closed = createInitialState();
    await inner.saveState("test", closed);

    // Other instance should read from inner, not from first instance's cache
    const result = await otherCached.getState("test");
    expect(result?.circuitState).toBe("CLOSED");
  });
});

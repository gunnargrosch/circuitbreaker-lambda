import { describe, it, expect, beforeEach } from "vitest";
import { MemoryProvider } from "../memory-provider.js";
import { createInitialState } from "../types.js";

let provider: MemoryProvider;

beforeEach(() => {
  provider = new MemoryProvider();
});

describe("MemoryProvider", () => {
  it("should return undefined for unknown circuit", async () => {
    const result = await provider.getState("unknown");
    expect(result).toBeUndefined();
  });

  it("should store and retrieve state", async () => {
    const state = createInitialState();
    state.circuitState = "OPEN";

    await provider.saveState("test", state);
    const result = await provider.getState("test");

    expect(result?.circuitState).toBe("OPEN");
  });

  it("should store a copy, not a reference", async () => {
    const state = createInitialState();
    await provider.saveState("test", state);

    state.failureCount = 99;
    const result = await provider.getState("test");

    expect(result?.failureCount).toBe(0);
  });

  it("should return a copy from getState, not a reference", async () => {
    await provider.saveState("test", createInitialState());

    const result = await provider.getState("test");
    if (result) result.failureCount = 99;

    const second = await provider.getState("test");
    expect(second?.failureCount).toBe(0);
  });

  it("should clear all state", async () => {
    await provider.saveState("a", createInitialState());
    await provider.saveState("b", createInitialState());

    provider.clear();

    expect(await provider.getState("a")).toBeUndefined();
    expect(await provider.getState("b")).toBeUndefined();
  });
});

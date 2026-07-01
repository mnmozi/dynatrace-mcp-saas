import { describe, it, expect } from "vitest";
import { requireWrites } from "../src/util/guards.js";
import type { Config } from "../src/types.js";

const cfg = (enableWrites: boolean): Config => ({
  platformUrl: "x",
  classicUrl: "x",
  platformToken: "x",
  apiToken: "x",
  enableWrites,
  timeoutMs: 1,
});

describe("requireWrites", () => {
  it("throws when writes disabled", () => {
    expect(() => requireWrites(cfg(false))).toThrow(/DT_ENABLE_WRITES=true/);
  });
  it("does nothing when writes enabled", () => {
    expect(() => requireWrites(cfg(true))).not.toThrow();
  });
});

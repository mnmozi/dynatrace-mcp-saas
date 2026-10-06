import { describe, it, expect } from "vitest";
import { containsIgnoreCase } from "../../src/util/text-match.js";

describe("containsIgnoreCase", () => {
  it("matches a fragment whose case differs from the text", () => {
    expect(containsIgnoreCase("builtin:oneagent.features", "OneAgent")).toBe(true);
  });

  it("matches a fragment in the middle of the text", () => {
    expect(containsIgnoreCase("SENSOR_JAVA_TRACE_SAMPLING", "trace_samp")).toBe(true);
  });

  it("rejects a fragment that is not in the text", () => {
    expect(containsIgnoreCase("builtin:tags", "sampling")).toBe(false);
  });
});

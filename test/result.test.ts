import { describe, it, expect } from "vitest";
import { jsonResult, textResult } from "../src/util/result.js";

describe("jsonResult", () => {
  it("serializes an object to JSON text", () => {
    const r = jsonResult({ a: 1 });
    expect(r.content[0].type).toBe("text");
    expect(r.content[0].text).toContain('"a": 1');
  });

  it("returns a valid string for undefined (e.g. 204/empty DELETE bodies)", () => {
    const r = jsonResult(undefined);
    // must be a string, never the value `undefined` (would be an invalid MCP result)
    expect(typeof r.content[0].text).toBe("string");
    expect(r.content[0].text).toContain("success");
  });

  it("textResult wraps a string", () => {
    expect(textResult("hi").content[0].text).toBe("hi");
  });
});

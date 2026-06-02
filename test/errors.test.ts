import { describe, it, expect } from "vitest";
import { DynatraceApiError, friendlyMessage } from "../src/http/errors.js";

describe("friendlyMessage", () => {
  it("explains 401 with token-type hint", () => {
    expect(friendlyMessage(401, "platform")).toMatch(/Bearer.*platform token/i);
    expect(friendlyMessage(401, "classic")).toMatch(/Api-Token/i);
  });
  it("explains 403 as missing scope", () => {
    expect(friendlyMessage(403, "classic")).toMatch(/scope/i);
  });
  it("explains 404 as not found / unavailable", () => {
    expect(friendlyMessage(404, "platform")).toMatch(/not found|unavailable/i);
  });
});

describe("DynatraceApiError", () => {
  it("carries status, host, and body", () => {
    const e = new DynatraceApiError(429, "platform", { error: "rate" }, "/x");
    expect(e.status).toBe(429);
    expect(e.host).toBe("platform");
    expect(e.message).toMatch(/429/);
  });
});

import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DT_PLATFORM_URL: "https://x.apps.dynatracelabs.com/",
  DT_CLASSIC_URL: "https://x.dynatracelabs.com",
  DT_PLATFORM_TOKEN: "dt0s16.AAA",
  DT_API_TOKEN: "dt0c01.BBB",
};

describe("loadConfig", () => {
  it("parses env, strips trailing slash, defaults writes off", () => {
    const c = loadConfig(base);
    expect(c.platformUrl).toBe("https://x.apps.dynatracelabs.com");
    expect(c.classicUrl).toBe("https://x.dynatracelabs.com");
    expect(c.enableWrites).toBe(false);
    expect(c.timeoutMs).toBe(30000);
  });

  it("enables writes only when exactly 'true'", () => {
    expect(loadConfig({ ...base, DT_ENABLE_WRITES: "true" }).enableWrites).toBe(true);
    expect(loadConfig({ ...base, DT_ENABLE_WRITES: "1" }).enableWrites).toBe(false);
  });

  it("throws a clear error when a required var is missing", () => {
    const { DT_API_TOKEN, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DT_API_TOKEN/);
  });
});

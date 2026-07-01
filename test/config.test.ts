import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DT_PLATFORM_URL: "https://x.apps.dynatracelabs.com/",
  DT_CLASSIC_URL: "https://x.dynatracelabs.com",
  DT_PLATFORM_TOKEN: "dt0s16.AAA",
  DT_API_TOKEN: "dt0c01.BBB",
};

const platformOnly = {
  DT_PLATFORM_URL: "https://x.apps.dynatracelabs.com/",
  DT_PLATFORM_TOKEN: "dt0s16.AAA",
};

const classicOnly = {
  DT_CLASSIC_URL: "https://x.dynatracelabs.com",
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

  // --- partial-credential mode ---

  it("platform-only env succeeds; classicUrl and apiToken are undefined", () => {
    const c = loadConfig(platformOnly);
    expect(c.platformUrl).toBe("https://x.apps.dynatracelabs.com");
    expect(c.platformToken).toBe("dt0s16.AAA");
    expect(c.classicUrl).toBeUndefined();
    expect(c.apiToken).toBeUndefined();
  });

  it("classic-only env succeeds; platformUrl and platformToken are undefined", () => {
    const c = loadConfig(classicOnly);
    expect(c.classicUrl).toBe("https://x.dynatracelabs.com");
    expect(c.apiToken).toBe("dt0c01.BBB");
    expect(c.platformUrl).toBeUndefined();
    expect(c.platformToken).toBeUndefined();
  });

  it("throws when neither pair is provided", () => {
    expect(() => loadConfig({})).toThrow(/at least one pair/i);
  });

  it("throws naming the missing var when DT_PLATFORM_URL is set without DT_PLATFORM_TOKEN", () => {
    expect(() => loadConfig({ DT_PLATFORM_URL: "https://x.apps.dynatracelabs.com" })).toThrow(/DT_PLATFORM_TOKEN/);
  });

  it("throws naming the missing var when DT_PLATFORM_TOKEN is set without DT_PLATFORM_URL", () => {
    expect(() => loadConfig({ DT_PLATFORM_TOKEN: "dt0s16.AAA" })).toThrow(/DT_PLATFORM_URL/);
  });

  it("throws naming the missing var when DT_CLASSIC_URL is set without DT_API_TOKEN", () => {
    expect(() => loadConfig({ DT_CLASSIC_URL: "https://x.dynatracelabs.com" })).toThrow(/DT_API_TOKEN/);
  });

  it("throws naming the missing var when DT_API_TOKEN is set without DT_CLASSIC_URL", () => {
    expect(() => loadConfig({ DT_API_TOKEN: "dt0c01.BBB" })).toThrow(/DT_CLASSIC_URL/);
  });
});

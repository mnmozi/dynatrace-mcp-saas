import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { DynatraceClient } from "../src/http/client.js";
import { DynatraceApiError } from "../src/http/errors.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "PTOK",
  apiToken: "ATOK",
  enableWrites: false,
  timeoutMs: 5000,
  maxRetries: 0,   // no retries in basic client tests
  retryBaseMs: 0,
};

const server = setupServer(
  http.get("https://classic.example.com/api/v2/ping", ({ request }) => {
    return HttpResponse.json({ auth: request.headers.get("authorization") });
  }),
  http.get("https://plat.example.com/platform/ping", ({ request }) => {
    return HttpResponse.json({ auth: request.headers.get("authorization") });
  }),
  http.get("https://classic.example.com/api/v2/boom", () =>
    HttpResponse.json({ error: { message: "no" } }, { status: 403 }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("DynatraceClient", () => {
  const c = new DynatraceClient(cfg);

  it("uses Api-Token on classic host", async () => {
    const r = await c.classic.get<{ auth: string }>("/api/v2/ping");
    expect(r.auth).toBe("Api-Token ATOK");
  });

  it("uses Bearer on platform host", async () => {
    const r = await c.platform.get<{ auth: string }>("/platform/ping");
    expect(r.auth).toBe("Bearer PTOK");
  });

  it("throws DynatraceApiError on non-2xx", async () => {
    await expect(c.classic.get("/api/v2/boom")).rejects.toBeInstanceOf(DynatraceApiError);
  });
});

describe("DynatraceClient — platform-only (partial-credential mode)", () => {
  const platformOnlyCfg: Config = {
    platformUrl: "https://plat.example.com",
    platformToken: "PTOK",
    classicUrl: undefined,
    apiToken: undefined,
    enableWrites: false,
    timeoutMs: 5000,
    maxRetries: 0,
    retryBaseMs: 0,
  };

  const c = new DynatraceClient(platformOnlyCfg);

  it("classic.get rejects with 'not configured' and names the missing env vars", async () => {
    await expect(c.classic.get("/x")).rejects.toThrow(/not configured/i);
    await expect(c.classic.get("/x")).rejects.toThrow(/DT_API_TOKEN/);
  });

  it("platform still works (mock GET succeeds)", async () => {
    const r = await c.platform.get<{ auth: string }>("/platform/ping");
    expect(r.auth).toBe("Bearer PTOK");
  });
});

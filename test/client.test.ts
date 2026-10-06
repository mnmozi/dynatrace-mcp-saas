import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse, delay } from "msw";
import { DynatraceClient } from "../src/http/client.js";
import { DynatraceApiError, DynatraceNetworkError } from "../src/http/errors.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "PTOK",
  apiToken: "ATOK",
  enableWrites: false,
  timeoutMs: 5000,
  maxRetries: 0, // no retries in basic client tests
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

  it("tells the caller how long Dynatrace asked to wait on a 429", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/busy", () =>
        HttpResponse.json(
          { error: { code: 429, message: "Too many requests" } },
          { status: 429, headers: { "Retry-After": "7" } },
        ),
      ),
    );
    await expect(c.classic.get("/api/v2/busy")).rejects.toThrow(
      "429 Too Many Requests: rate limited; retry after 7 s. (classic /api/v2/busy) — Too many requests",
    );
  });
});

describe("DynatraceClient — no HTTP response", () => {
  it("names the request when the connection fails", async () => {
    server.use(http.get("https://classic.example.com/api/v2/down", () => HttpResponse.error()));
    const failure = await new DynatraceClient(cfg).classic.get("/api/v2/down").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DynatraceNetworkError);
    expect((failure as Error).message).toBe(
      "Could not reach Dynatrace (classic GET /api/v2/down): connection failed. Check DT_CLASSIC_URL and network access.",
    );
  });

  it("does not echo a malformed token back when fetch refuses to send it", async () => {
    const lineBrokenToken = new DynatraceClient({ ...cfg, apiToken: "ATOK\nSECRETPART" });
    const failure = (await lineBrokenToken.classic.get("/api/v2/ping").catch((e: unknown) => e)) as Error;
    expect(failure).toBeInstanceOf(DynatraceNetworkError);
    expect(failure.message).not.toContain("SECRETPART");
    expect(failure.message).toContain("Check DT_API_TOKEN.");
  });

  it("reports a timeout with its duration and warns that a write may have been applied", async () => {
    server.use(
      http.put("https://plat.example.com/platform/slow", async () => {
        await delay(500);
        return HttpResponse.json({});
      }),
    );
    const impatient = new DynatraceClient({ ...cfg, timeoutMs: 20 });
    await expect(impatient.platform.put("/platform/slow", { a: 1 })).rejects.toThrow(
      "Timed out after 20 ms waiting for Dynatrace (platform PUT /platform/slow). " +
        "If this request changes data it may still have been applied — check before retrying. " +
        "Raise DT_HTTP_TIMEOUT_MS if this endpoint is slow.",
    );
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

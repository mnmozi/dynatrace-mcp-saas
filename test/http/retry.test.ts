/**
 * Retry + 429 handling tests for HostClientImpl (via DynatraceClient).
 *
 * Uses msw to intercept HTTP so no real network is involved.
 * Config uses tiny values so tests run fast: maxRetries=3, retryBaseMs=1.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { DynatraceClient } from "../../src/http/client.js";
import { DynatraceApiError } from "../../src/http/errors.js";
import type { Config } from "../../src/types.js";

const BASE = "https://retry-test.example.com";

const cfg: Config = {
  platformUrl: BASE,
  classicUrl: BASE,
  platformToken: "PTOK",
  apiToken: "ATOK",
  enableWrites: false,
  timeoutMs: 1000,
  maxRetries: 3,
  retryBaseMs: 1, // 1 ms base → near-instant backoff
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Helper to build a DynatraceClient whose classic host points at BASE.
const client = new DynatraceClient(cfg);

// ── Test 1: 429 then 200 ──────────────────────────────────────────────────────
describe("429 then 200", () => {
  it("resolves after one retry when first response is 429 with Retry-After: 0", async () => {
    let callCount = 0;

    server.use(
      http.get(`${BASE}/api/v2/test-429-200`, () => {
        callCount++;
        if (callCount === 1) {
          return new HttpResponse(JSON.stringify({ detail: "rate limited" }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "0" },
          });
        }
        return HttpResponse.json({ ok: true });
      }),
    );

    const result = await client.classic.get<{ ok: boolean }>("/api/v2/test-429-200");
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });
});

// ── Test 2: 503 then 503 then 200 ────────────────────────────────────────────
describe("503 then 503 then 200", () => {
  it("resolves after two retries on 503 responses", async () => {
    let callCount = 0;

    server.use(
      http.get(`${BASE}/api/v2/test-503`, () => {
        callCount++;
        if (callCount < 3) {
          return HttpResponse.json({ error: "server error" }, { status: 503 });
        }
        return HttpResponse.json({ ok: true });
      }),
    );

    const result = await client.classic.get<{ ok: boolean }>("/api/v2/test-503");
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(3);
  });
});

// ── Test 3: 400 — no retry ────────────────────────────────────────────────────
describe("400 no retry", () => {
  it("throws DynatraceApiError immediately without retrying on 400", async () => {
    let callCount = 0;

    server.use(
      http.get(`${BASE}/api/v2/test-400`, () => {
        callCount++;
        return HttpResponse.json({ error: "bad request" }, { status: 400 });
      }),
    );

    await expect(client.classic.get("/api/v2/test-400"))
      .rejects.toBeInstanceOf(DynatraceApiError);

    const err = await client.classic
      .get("/api/v2/test-400")
      .catch((e: unknown) => e);
    expect((err as DynatraceApiError).status).toBe(400);

    // callCount should be 2 (one from each get() call, no retries on either)
    expect(callCount).toBe(2);
  });
});

// ── Test 4: 429 exhausts retries ─────────────────────────────────────────────
describe("429 exhausts retries", () => {
  it("throws DynatraceApiError(429) after maxRetries+1 attempts when always 429", async () => {
    let callCount = 0;

    server.use(
      http.get(`${BASE}/api/v2/test-429-exhaust`, () => {
        callCount++;
        return new HttpResponse(JSON.stringify({ detail: "still rate limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "0" },
        });
      }),
    );

    let thrownError: unknown;
    try {
      await client.classic.get("/api/v2/test-429-exhaust");
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(DynatraceApiError);
    expect((thrownError as DynatraceApiError).status).toBe(429);
    // maxRetries=3 → 1 initial attempt + 3 retries = 4 total
    expect(callCount).toBe(cfg.maxRetries + 1);
  });
});

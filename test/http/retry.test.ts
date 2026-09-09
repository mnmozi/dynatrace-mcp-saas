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
import { classAllowsRetry, defaultClassFor } from "../../src/http/retry.js";
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

    await expect(client.classic.get("/api/v2/test-400")).rejects.toBeInstanceOf(DynatraceApiError);

    const err = await client.classic.get("/api/v2/test-400").catch((e: unknown) => e);
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

// ── Unit: the classification table (the heart of the engine) ─────────────────
describe("classAllowsRetry table", () => {
  it("429/408 always retry, for every class (rejected before processing)", () => {
    for (const cls of ["idempotent", "create", "append"] as const) {
      expect(classAllowsRetry(cls, 429, false)).toBe(true);
      expect(classAllowsRetry(cls, 408, false)).toBe(true);
    }
  });

  it("5xx retries ONLY for idempotent (create/append may have applied)", () => {
    expect(classAllowsRetry("idempotent", 503, false)).toBe(true);
    expect(classAllowsRetry("create", 503, false)).toBe(false);
    expect(classAllowsRetry("append", 500, false)).toBe(false);
  });

  it("network errors retry for idempotent + create, NEVER for append (silent duplicate)", () => {
    expect(classAllowsRetry("idempotent", undefined, true)).toBe(true);
    expect(classAllowsRetry("create", undefined, true)).toBe(true);
    expect(classAllowsRetry("append", undefined, true)).toBe(false);
  });

  it("other 4xx / 3xx are terminal for every class", () => {
    for (const cls of ["idempotent", "create", "append"] as const) {
      expect(classAllowsRetry(cls, 400, false)).toBe(false);
      expect(classAllowsRetry(cls, 404, false)).toBe(false);
      expect(classAllowsRetry(cls, 301, false)).toBe(false);
    }
  });

  it("defaultClassFor: GET/PUT/DELETE = idempotent, POST/PATCH = create", () => {
    expect(defaultClassFor("GET")).toBe("idempotent");
    expect(defaultClassFor("put")).toBe("idempotent");
    expect(defaultClassFor("DELETE")).toBe("idempotent");
    expect(defaultClassFor("POST")).toBe("create");
    expect(defaultClassFor("PATCH")).toBe("create");
  });
});

// ── append ingest does NOT retry on 5xx (would duplicate the record) ─────────
describe("append class 5xx", () => {
  it("throws immediately on 503 without retrying when retryClass='append'", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE}/api/v2/logs/ingest`, () => {
        callCount++;
        return HttpResponse.json({ error: "server error" }, { status: 503 });
      }),
    );

    await expect(
      client.classic.post("/api/v2/logs/ingest", { msg: "x" }, undefined, { retryClass: "append" }),
    ).rejects.toBeInstanceOf(DynatraceApiError);

    // append must NOT retry a 5xx — exactly one attempt.
    expect(callCount).toBe(1);
  });
});

// ── create class retries a network error (a duplicate config is deletable) ───
describe("create class network error", () => {
  it("retries a network failure then succeeds for a default POST (create)", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE}/api/v2/create-net`, () => {
        callCount++;
        if (callCount === 1) return HttpResponse.error(); // simulated network drop
        return HttpResponse.json({ ok: true });
      }),
    );

    const result = await client.classic.post<{ ok: boolean }>("/api/v2/create-net", { a: 1 });
    expect(result).toEqual({ ok: true });
    expect(callCount).toBe(2);
  });

  it("does NOT retry a network failure when retryClass='append'", async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE}/api/v2/append-net`, () => {
        callCount++;
        return HttpResponse.error();
      }),
    );

    await expect(
      client.classic.post("/api/v2/append-net", { a: 1 }, undefined, { retryClass: "append" }),
    ).rejects.toBeTruthy();
    expect(callCount).toBe(1);
  });
});

// ── verifyApplied: an ambiguous write is salvaged by the caller's checker ─────
describe("verifyApplied hook", () => {
  it("returns the verifier's value instead of retrying/throwing on an append 5xx", async () => {
    let callCount = 0;
    let verifyCalls = 0;
    server.use(
      http.post(`${BASE}/api/v2/verify-me`, () => {
        callCount++;
        return HttpResponse.json({ error: "server error" }, { status: 503 });
      }),
    );

    const result = await client.classic.post<{ found: string }>("/api/v2/verify-me", { a: 1 }, undefined, {
      retryClass: "append",
      verifyApplied: async () => {
        verifyCalls++;
        return { found: "it-landed" };
      },
    });

    expect(result).toEqual({ found: "it-landed" });
    expect(verifyCalls).toBe(1);
    // The write itself was attempted once; the verifier salvaged the ambiguous failure.
    expect(callCount).toBe(1);
  });
});

// ── DELETE that 404s on a retry means the first attempt already removed it ────
describe("DELETE 404 on retry", () => {
  it("treats a 404 after a retried 503 as success (idempotent delete)", async () => {
    let callCount = 0;
    server.use(
      http.delete(`${BASE}/api/v2/gone`, () => {
        callCount++;
        if (callCount === 1) return HttpResponse.json({ error: "server error" }, { status: 503 });
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }),
    );

    // Should NOT throw — the 404-on-retry is treated as "already deleted".
    await expect(client.classic.del("/api/v2/gone")).resolves.toBeDefined();
    expect(callCount).toBe(2);
  });
});

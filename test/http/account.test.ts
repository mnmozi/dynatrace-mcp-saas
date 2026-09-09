/**
 * AccountClient retry wiring.
 *
 * The AccountClient was refactored onto the shared runWithRetry engine (previously
 * bare fetch, no retry). These tests prove the account surface actually goes through
 * the engine: idempotent retry on 5xx, DELETE-404-on-retry = success, and the SSO
 * token request itself retrying. Tiny retryBaseMs keeps it near-instant.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: undefined,
  platformToken: "PT",
  apiToken: undefined,
  enableWrites: true,
  timeoutMs: 1000,
  oauthClientId: "cid",
  oauthClientSecret: "csecret",
  accountUrn: `urn:dtaccount:${ACCOUNT_UUID}`,
  ssoTokenUrl: SSO,
  accountApiUrl: API,
  oauthScope: "iam-policies-management",
  maxRetries: 3,
  retryBaseMs: 1,
};

const okToken = () => HttpResponse.json({ access_token: "oauth-tok", expires_in: 300 });
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Fresh client per test so the per-scope token cache doesn't leak across cases.
function account() {
  return new DynatraceClient(cfg).requireAccount();
}

describe("AccountClient retry wiring", () => {
  it("retries a GET on 503 then succeeds (idempotent, via the shared engine)", async () => {
    let calls = 0;
    server.use(
      http.post(SSO, okToken),
      http.get(`${API}/probe`, () => {
        calls++;
        if (calls < 3) return HttpResponse.json({ error: "flaky" }, { status: 503 });
        return HttpResponse.json({ ok: true });
      }),
    );

    const res = await account().get<{ ok: boolean }>("/probe");
    expect(res).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("treats a DELETE that 404s on a retry as success (already deleted)", async () => {
    let calls = 0;
    server.use(
      http.post(SSO, okToken),
      http.delete(`${API}/thing`, () => {
        calls++;
        if (calls === 1) return HttpResponse.json({ error: "flaky" }, { status: 503 });
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }),
    );

    await expect(account().del("/thing")).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it("retries the SSO token request itself on a 503 then mints the token", async () => {
    let tokenCalls = 0;
    server.use(
      http.post(SSO, () => {
        tokenCalls++;
        if (tokenCalls === 1) return HttpResponse.json({ error: "sso down" }, { status: 503 });
        return okToken();
      }),
      http.get(`${API}/after-token`, () => HttpResponse.json({ ok: true })),
    );

    const res = await account().get<{ ok: boolean }>("/after-token");
    expect(res).toEqual({ ok: true });
    expect(tokenCalls).toBe(2);
  });

  it("passes a retryClass override through to the engine (append POST does NOT retry 5xx)", async () => {
    let calls = 0;
    server.use(
      http.post(SSO, okToken),
      http.post(`${API}/ingestish`, () => {
        calls++;
        return HttpResponse.json({ error: "boom" }, { status: 503 });
      }),
    );

    await expect(account().post("/ingestish", { a: 1 }, undefined, { retryClass: "append" })).rejects.toBeTruthy();
    expect(calls).toBe(1);
  });
});

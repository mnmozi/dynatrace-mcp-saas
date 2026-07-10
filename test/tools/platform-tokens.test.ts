import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPlatformTokenTools } from "../../src/tools/platform-tokens.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";
const TOKENS = `${API}/iam/v1/accounts/${ACCOUNT_UUID}/platform-tokens`;

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
  oauthClientId: "cid",
  oauthClientSecret: "csecret",
  accountUrn: `urn:dtaccount:${ACCOUNT_UUID}`,
  ssoTokenUrl: SSO,
  accountApiUrl: API,
};

const scopes: string[] = [];
const mswServer = setupServer(
  http.post(SSO, async ({ request }) => {
    scopes.push(new URLSearchParams(await request.text()).get("scope") ?? "");
    return HttpResponse.json({ access_token: `tok-${scopes[scopes.length - 1]}`, expires_in: 300 });
  }),
);
beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  mswServer.resetHandlers();
  scopes.length = 0;
});
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerPlatformTokenTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("create_platform_token", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_platform_token",
      arguments: { name: "t", userUuid: "u1", scopes: ["storage:logs:read"], expirationDate: "2026-07-11T00:00:00Z" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/DT_ENABLE_WRITES/);
  });

  it("POSTs userUuid + scope + resource + tags with account-idm-write", async () => {
    let body: Record<string, unknown> = {};
    let auth = "";
    mswServer.use(
      http.post(TOKENS, async ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "tk-1", token: "dt0s16.SECRET" }, { status: 201 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "create_platform_token",
      arguments: {
        name: "test-mostafa",
        userUuid: "6fc5dae6",
        scopes: ["storage:bizevents:read"],
        expirationDate: "2026-07-11T00:00:00Z",
      },
    });
    expect(res.isError).toBeFalsy();
    expect(body.userUuid).toBe("6fc5dae6");
    expect(body.scope).toEqual(["storage:bizevents:read"]);
    expect(body.resource).toEqual([]);
    expect(body.tags).toEqual([]);
    expect(auth).toBe("Bearer tok-account-idm-write");
  });
});

describe("delete_platform_token", () => {
  it("DELETEs by id with the write scope", async () => {
    let url = "";
    mswServer.use(
      http.delete(`${TOKENS}/tk-1`, ({ request }) => {
        url = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({ name: "delete_platform_token", arguments: { tokenId: "tk-1" } });
    expect(res.isError).toBeFalsy();
    expect(url).toContain("/platform-tokens/tk-1");
  });
});

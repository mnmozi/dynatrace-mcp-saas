import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIamGroupTools } from "../../src/tools/iam-groups.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";
const GROUPS = `${API}/iam/v1/accounts/${ACCOUNT_UUID}/groups`;

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

// Record which scope each token request asked for.
const scopeRequests: string[] = [];
const mswServer = setupServer(
  http.post(SSO, async ({ request }) => {
    const params = new URLSearchParams(await request.text());
    const scope = params.get("scope") ?? "";
    scopeRequests.push(scope);
    return HttpResponse.json({ access_token: `tok-${scope}`, expires_in: 300 });
  }),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  mswServer.resetHandlers();
  scopeRequests.length = 0;
});
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerIamGroupTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("list_account_groups", () => {
  it("uses the account-idm-read scope and returns groups", async () => {
    let auth = "";
    mswServer.use(
      http.get(GROUPS, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ count: 1, items: [{ uuid: "g1", name: "Account Admins" }] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_account_groups", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("Account Admins");
    expect(scopeRequests).toContain("account-idm-read");
    expect(auth).toBe("Bearer tok-account-idm-read");
  });
});

describe("create_account_group", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "create_account_group", arguments: { name: "team-x" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/DT_ENABLE_WRITES/);
  });

  it("POSTs an array of groups with the account-idm-write scope", async () => {
    let body: unknown = null;
    let auth = "";
    mswServer.use(
      http.post(GROUPS, async ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        body = await request.json();
        return HttpResponse.json([{ uuid: "g-new", name: "team-x" }], { status: 201 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "create_account_group",
      arguments: { name: "team-x", description: "team x group" },
    });
    expect(res.isError).toBeFalsy();
    expect(Array.isArray(body)).toBe(true);
    expect((body as Array<Record<string, unknown>>)[0].name).toBe("team-x");
    expect(auth).toBe("Bearer tok-account-idm-write");
    expect(scopeRequests).toContain("account-idm-write");
  });
});

describe("delete_account_group", () => {
  it("DELETEs with the write scope", async () => {
    let auth = "";
    mswServer.use(
      http.delete(`${GROUPS}/g1`, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({ name: "delete_account_group", arguments: { groupUuid: "g1" } });
    expect(res.isError).toBeFalsy();
    expect(auth).toBe("Bearer tok-account-idm-write");
  });
});

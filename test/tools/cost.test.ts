import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCostTools } from "../../src/tools/cost.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";
const SUBS = `${API}/sub/v2/accounts/${ACCOUNT_UUID}/subscriptions`;

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

const scopeRequests: string[] = [];
const mswServer = setupServer(
  http.post(SSO, async ({ request }) => {
    const scope = new URLSearchParams(await request.text()).get("scope") ?? "";
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
  registerCostTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("list_subscriptions", () => {
  it("uses the account-uac-read scope", async () => {
    let auth = "";
    mswServer.use(
      http.get(SUBS, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ subscriptions: [{ uuid: "sub-1" }] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_subscriptions", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("sub-1");
    expect(auth).toBe("Bearer tok-account-uac-read");
    expect(scopeRequests).toContain("account-uac-read");
  });
});

describe("get_subscription_cost", () => {
  it("joins filter arrays into comma-separated query params", async () => {
    let url = "";
    mswServer.use(
      http.get(`${SUBS}/sub-1/cost`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ cost: [{ capability: "logs", amount: 42 }] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "get_subscription_cost",
      arguments: { subscriptionUuid: "sub-1", environmentIds: ["env-a", "env-b"], capabilityKeys: ["logs"] },
    });
    expect(res.isError).toBeFalsy();
    const q = new URL(url).searchParams;
    expect(q.get("environmentIds")).toBe("env-a,env-b");
    expect(q.get("capabilityKeys")).toBe("logs");
    expect(text(res)).toContain("logs");
  });
});

describe("get_subscription_usage", () => {
  it("fetches usage for a subscription", async () => {
    mswServer.use(http.get(`${SUBS}/sub-1/usage`, () => HttpResponse.json({ usage: [{ metric: "ddu", value: 100 }] })));
    const client = await makeClient();
    const res = await client.callTool({ name: "get_subscription_usage", arguments: { subscriptionUuid: "sub-1" } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("ddu");
  });
});

describe("not configured", () => {
  it("errors clearly without the OAuth trio", async () => {
    const bare: Config = { ...cfg, oauthClientId: undefined, oauthClientSecret: undefined, accountUrn: undefined };
    const client = await makeClient(bare);
    const res = await client.callTool({ name: "list_subscriptions", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("DT_OAUTH_CLIENT_ID");
  });
});

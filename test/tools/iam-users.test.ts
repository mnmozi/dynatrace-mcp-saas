import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIamUserTools } from "../../src/tools/iam-users.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";
const ACC = `${API}/iam/v1/accounts/${ACCOUNT_UUID}`;

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
  registerIamUserTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("list_group_members", () => {
  it("lists a group's users via account-idm-read (closes the platform-token 403 gap)", async () => {
    let auth = "";
    mswServer.use(
      http.get(`${ACC}/groups/g-demo/users`, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ count: 1, items: [{ email: "a@b.com", uid: "u1" }] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_group_members", arguments: { groupUuid: "g-demo" } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("a@b.com");
    expect(auth).toBe("Bearer tok-account-idm-read");
    expect(scopeRequests).toContain("account-idm-read");
  });
});

describe("get_account_user", () => {
  it("url-encodes the email in the path", async () => {
    let url = "";
    mswServer.use(
      http.get(`${ACC}/users/:email`, ({ request }) => {
        url = request.url;
        return HttpResponse.json({ email: "a+x@b.com", groups: ["g1"] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "get_account_user", arguments: { email: "a+x@b.com" } });
    expect(res.isError).toBeFalsy();
    expect(url).toContain("a%2Bx%40b.com");
    expect(text(res)).toContain("g1");
  });
});

describe("list_account_users", () => {
  it("lists account users", async () => {
    mswServer.use(http.get(`${ACC}/users`, () => HttpResponse.json({ count: 2, items: [{ email: "a@b.com" }] })));
    const client = await makeClient();
    const res = await client.callTool({ name: "list_account_users", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("a@b.com");
  });
});

describe("not configured", () => {
  it("errors clearly without the OAuth trio", async () => {
    const bare: Config = { ...cfg, oauthClientId: undefined, oauthClientSecret: undefined, accountUrn: undefined };
    const client = await makeClient(bare);
    const res = await client.callTool({ name: "list_account_users", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("DT_OAUTH_CLIENT_ID");
  });
});

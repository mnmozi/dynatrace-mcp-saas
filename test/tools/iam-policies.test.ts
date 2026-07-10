import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIamPolicyTools } from "../../src/tools/iam-policies.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";
const REPO = `${API}/iam/v1/repo/account/${ACCOUNT_UUID}`;

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
  oauthScope: "iam-policies-management",
};

const mswServer = setupServer(http.post(SSO, () => HttpResponse.json({ access_token: "oauth-tok", expires_in: 300 })));

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerIamPolicyTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("list_policies", () => {
  it("lists account-level policies", async () => {
    mswServer.use(http.get(`${REPO}/policies`, () => HttpResponse.json({ policies: [{ uuid: "p1", name: "write" }] })));
    const client = await makeClient();
    const res = await client.callTool({ name: "list_policies", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("write");
  });

  it("targets the global level when levelType=global (levelId defaults to 'global')", async () => {
    let hit = "";
    mswServer.use(
      http.get(`${API}/iam/v1/repo/global/global/policies`, ({ request }) => {
        hit = request.url;
        return HttpResponse.json({ policies: [] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_policies", arguments: { levelType: "global" } });
    expect(res.isError).toBeFalsy();
    expect(hit).toContain("/repo/global/global/policies");
  });
});

describe("create_policy", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_policy",
      arguments: { name: "p", statementQuery: "ALLOW storage:events:read;" },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/DT_ENABLE_WRITES/);
  });

  it("POSTs name + statementQuery when writes are enabled", async () => {
    let body: Record<string, unknown> = {};
    mswServer.use(
      http.post(`${REPO}/policies`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ uuid: "p-new" }, { status: 201 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "create_policy",
      arguments: {
        name: "team-read",
        statementQuery: 'ALLOW storage:events:read WHERE storage:k8s.namespace.name = "apps";',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(body.name).toBe("team-read");
    expect(body.statementQuery).toContain("ALLOW storage:events:read");
    expect(text(res)).toContain("p-new");
  });
});

describe("bind_policy_to_groups", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "bind_policy_to_groups",
      arguments: { policyUuid: "p1", groups: ["g1"] },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/DT_ENABLE_WRITES/);
  });

  it("PUTs the policy binding with groups + optional boundaries", async () => {
    let body: Record<string, unknown> = {};
    let url = "";
    mswServer.use(
      http.put(`${REPO}/bindings/p1`, async ({ request }) => {
        url = request.url;
        body = (await request.json()) as Record<string, unknown>;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "bind_policy_to_groups",
      arguments: { policyUuid: "p1", groups: ["g1", "g2"], boundaries: ["b1"] },
    });
    expect(res.isError).toBeFalsy();
    expect(url).toContain("/bindings/p1");
    expect(body.groups).toEqual(["g1", "g2"]);
    expect(body.boundaries).toEqual(["b1"]);
  });
});

describe("unbind_policy_from_group", () => {
  it("DELETEs the policy/group binding", async () => {
    let url = "";
    mswServer.use(
      http.delete(`${REPO}/bindings/p1/g1`, ({ request }) => {
        url = request.url;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "unbind_policy_from_group",
      arguments: { policyUuid: "p1", groupUuid: "g1" },
    });
    expect(res.isError).toBeFalsy();
    expect(url).toContain("/bindings/p1/g1");
  });
});

describe("not-configured error", () => {
  it("errors clearly when the OAuth trio is absent", async () => {
    const bare: Config = { ...cfg, oauthClientId: undefined, oauthClientSecret: undefined, accountUrn: undefined };
    const client = await makeClient(bare);
    const res = await client.callTool({ name: "list_policies", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("DT_OAUTH_CLIENT_ID");
  });
});

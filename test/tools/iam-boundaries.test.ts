import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIamBoundaryTools } from "../../src/tools/iam-boundaries.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";
const REPO = `${API}/iam/v1/repo/account/${ACCOUNT_UUID}/boundaries`;

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

let tokenRequests = 0;
let lastTokenBody = "";

const mswServer = setupServer(
  http.post(SSO, async ({ request }) => {
    tokenRequests++;
    lastTokenBody = await request.text();
    return HttpResponse.json({ access_token: "oauth-tok", expires_in: 300 });
  }),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  mswServer.resetHandlers();
  tokenRequests = 0;
  lastTokenBody = "";
});
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerIamBoundaryTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

function text(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ text: string }>)[0].text;
}

describe("list_policy_boundaries", () => {
  it("fetches an OAuth token then lists boundaries at the account level (uuid from URN)", async () => {
    let auth = "";
    mswServer.use(
      http.get(REPO, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ boundaries: [{ uuid: "b-1", name: "team-a-only" }] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_policy_boundaries", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("team-a-only");
    expect(auth).toBe("Bearer oauth-tok");
    expect(tokenRequests).toBe(1);
    expect(lastTokenBody).toContain("grant_type=client_credentials");
    expect(lastTokenBody).toContain(`resource=urn%3Adtaccount%3A${ACCOUNT_UUID}`);
  });

  it("caches the token across calls", async () => {
    mswServer.use(http.get(REPO, () => HttpResponse.json({ boundaries: [] })));
    const client = await makeClient();
    await client.callTool({ name: "list_policy_boundaries", arguments: {} });
    await client.callTool({ name: "list_policy_boundaries", arguments: {} });
    expect(tokenRequests).toBe(1);
  });

  it("returns a clear error when the OAuth trio is not configured", async () => {
    const bare: Config = { ...cfg, oauthClientId: undefined, oauthClientSecret: undefined, accountUrn: undefined };
    const client = await makeClient(bare);
    const res = await client.callTool({ name: "list_policy_boundaries", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("DT_OAUTH_CLIENT_ID");
  });
});

describe("create_policy_boundary", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_policy_boundary",
      arguments: { name: "b", boundaryQuery: 'environment:management-zone = "MZ";' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/DT_ENABLE_WRITES/);
  });

  it("POSTs name + boundaryQuery when writes are enabled", async () => {
    let captured: unknown = null;
    mswServer.use(
      http.post(REPO, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ uuid: "b-new", name: "team-a-only" }, { status: 201 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "create_policy_boundary",
      arguments: { name: "team-a-only", boundaryQuery: 'environment:management-zone = "team-a";' },
    });
    expect(res.isError).toBeFalsy();
    const body = captured as Record<string, unknown>;
    expect(body.name).toBe("team-a-only");
    expect(body.boundaryQuery).toBe('environment:management-zone = "team-a";');
    expect(text(res)).toContain("b-new");
  });
});

describe("update/delete_policy_boundary", () => {
  it("PUTs the replacement body to the boundary uuid", async () => {
    let captured: unknown = null;
    mswServer.use(
      http.put(`${REPO}/b-1`, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ uuid: "b-1", name: "renamed" });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "update_policy_boundary",
      arguments: { boundaryUuid: "b-1", name: "renamed", boundaryQuery: "environment(abc);" },
    });
    expect(res.isError).toBeFalsy();
    expect((captured as Record<string, unknown>).name).toBe("renamed");
  });

  it("DELETEs the boundary uuid", async () => {
    mswServer.use(http.delete(`${REPO}/b-1`, () => new HttpResponse(null, { status: 204 })));
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({ name: "delete_policy_boundary", arguments: { boundaryUuid: "b-1" } });
    expect(res.isError).toBeFalsy();
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPermissionTools } from "../../src/tools/permissions.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLAT = "https://plat.example.com";
const SSO = "https://sso.example.com/sso/oauth2/token";
const API = "https://acct.example.com";
const ACCOUNT_UUID = "11111111-2222-3333-4444-555555555555";
const ACCT = `${API}/iam/v1/accounts/${ACCOUNT_UUID}`;
const REPO = `${API}/iam/v1/repo/account/${ACCOUNT_UUID}`;
const GROUP = "grp-1";

const cfg: Config = {
  platformUrl: PLAT,
  classicUrl: undefined,
  platformToken: "PT",
  apiToken: undefined,
  enableWrites: false,
  timeoutMs: 5000,
  oauthClientId: "cid",
  oauthClientSecret: "csecret",
  accountUrn: `urn:dtaccount:${ACCOUNT_UUID}`,
  ssoTokenUrl: SSO,
  accountApiUrl: API,
  oauthScope: "iam-policies-management",
  maxRetries: 0,
  retryBaseMs: 1,
};

const mswServer = setupServer(
  http.post(SSO, () => HttpResponse.json({ access_token: "oauth-tok", expires_in: 300 })),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerPermissionTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

// Register the standard describe_group_permissions endpoint set. `bindings` lets a
// test inject the policyBindings array returned at the account level.
function stubGroupWorld(bindings: unknown[]) {
  mswServer.use(
    http.get(`${ACCT}/groups`, () =>
      HttpResponse.json({ items: [{ uuid: GROUP, name: "SRE" }, { uuid: "other", name: "Other" }] }),
    ),
    http.get(`${ACCT}/groups/${GROUP}/permissions`, () => HttpResponse.json({ permissions: [] })),
    http.get(`${ACCT}/groups/${GROUP}/users`, () => HttpResponse.json([{ uid: "u1", email: "a@b.co" }])),
    http.get(`${REPO}/bindings`, () => HttpResponse.json({ policyBindings: bindings })),
  );
}

describe("describe_group_permissions", () => {
  it("composes group → members → bindings → policy → boundary", async () => {
    stubGroupWorld([{ policyUuid: "pol-1", groups: [GROUP], boundaries: ["bnd-1"] }]);
    mswServer.use(
      http.get(`${REPO}/policies/pol-1`, () =>
        HttpResponse.json({ uuid: "pol-1", name: "read-logs", statementQuery: "ALLOW storage:logs:read;" }),
      ),
      http.get(`${REPO}/boundaries/bnd-1`, () =>
        HttpResponse.json({ uuid: "bnd-1", name: "prod-only", boundaryQuery: "dt.security_context = 'prod';" }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({ name: "describe_group_permissions", arguments: { groupUuid: GROUP } });
    const out = JSON.parse(text(res));

    expect(out.group).toMatchObject({ uuid: GROUP, name: "SRE" });
    expect(out.members).toEqual([{ uid: "u1", email: "a@b.co" }]);
    expect(out.bindingCount).toBe(1);
    expect(out.bindings[0].policy).toMatchObject({ name: "read-logs" });
    expect(out.bindings[0].boundaries[0]).toMatchObject({ name: "prod-only" });
    expect(out.legacyPermissions).toEqual([]);
  });

  it("keeps ONLY bindings that include the target group", async () => {
    // Two bindings: one for GROUP, one for a different group — only the first must survive.
    stubGroupWorld([
      { policyUuid: "pol-mine", groups: [GROUP] },
      { policyUuid: "pol-theirs", groups: ["other"] },
    ]);
    mswServer.use(
      http.get(`${REPO}/policies/pol-mine`, () => HttpResponse.json({ uuid: "pol-mine", name: "mine" })),
      // pol-theirs must NEVER be fetched; if it is, onUnhandledRequest:"error" would fail the test
      // only if unhandled — so assert via the result instead.
      http.get(`${REPO}/policies/pol-theirs`, () => HttpResponse.json({ uuid: "pol-theirs", name: "theirs" })),
    );

    const client = await makeClient();
    const res = await client.callTool({ name: "describe_group_permissions", arguments: { groupUuid: GROUP } });
    const out = JSON.parse(text(res));

    expect(out.bindingCount).toBe(1);
    expect(out.bindings[0].policyUuid).toBe("pol-mine");
  });

  it("still succeeds when the legacy-permissions endpoint fails (graceful)", async () => {
    stubGroupWorld([]);
    // Override the permissions endpoint to 500 — the tool must swallow it, not fail.
    mswServer.use(http.get(`${ACCT}/groups/${GROUP}/permissions`, () => HttpResponse.json({}, { status: 500 })));

    const client = await makeClient();
    const res = await client.callTool({ name: "describe_group_permissions", arguments: { groupUuid: GROUP } });
    const out = JSON.parse(text(res));

    expect(out.bindingCount).toBe(0);
    expect(out.legacyPermissions).toBeUndefined();
  });

  it("errors clearly when the group is not on the account", async () => {
    stubGroupWorld([]);
    const client = await makeClient();
    const res = await client.callTool({ name: "describe_group_permissions", arguments: { groupUuid: "ghost" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not found/i);
  });
});

describe("resolve_effective_permissions", () => {
  it("posts each permission (with mapped context) to the platform resolver", async () => {
    let captured: unknown;
    mswServer.use(
      http.post(`${PLAT}/platform/management/v1/effective-permissions:resolve`, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ permissions: [{ permission: "storage:logs:read", granted: true }] });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "resolve_effective_permissions",
      arguments: { permissions: ["storage:logs:read"], context: { "storage:k8s.cluster.name": "prod" } },
    });
    const out = JSON.parse(text(res));

    expect(out.permissions[0].granted).toBe(true);
    expect(captured).toEqual({
      permissions: [
        {
          permission: "storage:logs:read",
          context: [{ key: "storage:k8s.cluster.name", value: "prod" }],
        },
      ],
    });
  });
});

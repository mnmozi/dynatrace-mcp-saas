import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFieldsetTools } from "../../src/tools/fieldsets.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const BASE = `${PLATFORM}/platform/storage/fieldsets/v1/fieldsets`;

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(BASE, () =>
    HttpResponse.json({
      fieldsets: [{ uid: "fs-1", name: "log-defaults", fields: ["timestamp", "content"], scope: "TABLE" }],
    }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerFieldsetTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_fieldsets", () => {
  it("returns the fieldset list", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_fieldsets", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("log-defaults");
  });
});

describe("get_fieldset", () => {
  it("fetches a single fieldset by uid", async () => {
    mswServer.use(
      http.get(`${BASE}/fs-1`, () =>
        HttpResponse.json({ uid: "fs-1", name: "log-defaults", fields: ["timestamp"], scope: "TABLE", version: 3 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "get_fieldset", arguments: { fieldsetUid: "fs-1" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("log-defaults");
  });
});

describe("create_fieldset", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_fieldset",
      arguments: { name: "x", fields: ["a"], scope: "TENANT" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });

  it("POSTs the fieldset body when writes are enabled", async () => {
    let capturedBody: unknown = null;
    mswServer.use(
      http.post(BASE, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ uid: "fs-new", name: "sensitive", version: 1 }, { status: 201 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "create_fieldset",
      arguments: { name: "sensitive", fields: ["user.email"], scope: "TABLE", tables: ["logs"] },
    });
    expect(res.isError).toBeFalsy();
    const body = capturedBody as Record<string, unknown>;
    expect(body.name).toBe("sensitive");
    expect(body.fields).toEqual(["user.email"]);
    expect(body.scope).toBe("TABLE");
    expect(body.tables).toEqual(["logs"]);
  });
});

describe("update_fieldset", () => {
  it("PUTs with the optimistic-locking-version query param", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    mswServer.use(
      http.put(`${BASE}/fs-1`, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return HttpResponse.json({ uid: "fs-1", version: 4 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "update_fieldset",
      arguments: { fieldsetUid: "fs-1", version: 3, fields: ["timestamp", "loglevel"], scope: "TABLE" },
    });
    expect(res.isError).toBeFalsy();
    expect(capturedUrl).toContain("optimistic-locking-version=3");
    expect((capturedBody as Record<string, unknown>).fields).toEqual(["timestamp", "loglevel"]);
  });
});

describe("delete_fieldset", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "delete_fieldset", arguments: { fieldsetUid: "fs-1" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });

  it("sends DELETE when writes are enabled", async () => {
    mswServer.use(http.delete(`${BASE}/fs-1`, () => new HttpResponse(null, { status: 204 })));
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({ name: "delete_fieldset", arguments: { fieldsetUid: "fs-1" } });
    expect(res.isError).toBeFalsy();
  });
});

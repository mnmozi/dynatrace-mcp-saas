import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSettingsTools } from "../../src/tools/settings.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://p",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

// Capture the last request URL for assertion in pagination tests
let lastRequestUrl = "";

const server = setupServer(
  http.get("https://classic.example.com/api/v2/settings/schemas", ({ request }) => {
    lastRequestUrl = request.url;
    return HttpResponse.json({ items: [{ schemaId: "builtin:tags", displayName: "Tags" }], totalCount: 1 });
  }),
  http.get("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
    lastRequestUrl = request.url;
    return HttpResponse.json({ items: [{ objectId: "obj-1", schemaId: "builtin:tags", scope: "environment", value: {} }], totalCount: 1, nextPageKey: "NEXT1" });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); lastRequestUrl = ""; });
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerSettingsTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_settings_schemas", () => {
  it("returns schema list containing builtin:tags", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_settings_schemas", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("builtin:tags");
  });
});

describe("create_settings_object write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_settings_object",
      arguments: { schemaId: "builtin:tags", scope: "environment", value: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("list_settings_objects pagination", () => {
  it("first page: sends schemaIds and fields params", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "list_settings_objects",
      arguments: { schemaIds: "builtin:tags" },
    });
    expect(res.isError).toBeFalsy();
    const url = new URL(lastRequestUrl);
    expect(url.searchParams.get("schemaIds")).toBe("builtin:tags");
    expect(url.searchParams.get("fields")).toBeTruthy();
  });

  it("nextPageKey: URL contains only nextPageKey and NOT schemaIds/fields/pageSize", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "list_settings_objects",
      arguments: { nextPageKey: "ABC123", schemaIds: "builtin:tags" },
    });
    expect(res.isError).toBeFalsy();
    const url = new URL(lastRequestUrl);
    expect(url.searchParams.get("nextPageKey")).toBe("ABC123");
    expect(url.searchParams.has("schemaIds")).toBe(false);
    expect(url.searchParams.has("fields")).toBe(false);
    expect(url.searchParams.has("pageSize")).toBe(false);
  });
});

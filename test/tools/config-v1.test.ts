import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConfigV1Tools } from "../../src/tools/config-v1.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const CLASSIC = "https://classic.example.com";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: CLASSIC,
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(`${CLASSIC}/api/config/v1/service/requestAttributes`, () =>
    HttpResponse.json({ values: [{ id: "RA-1", name: "My Attr" }] }),
  ),
  http.get(`${CLASSIC}/api/config/v1/service/customServices/java`, () =>
    HttpResponse.json({ values: [{ id: "CS-1", name: "Checkout" }] }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerConfigV1Tools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_request_attributes", () => {
  it("returns request attributes list containing the attribute name", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_request_attributes", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("My Attr");
  });
});

describe("list_custom_services", () => {
  it("returns custom services list for a given technology", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "list_custom_services",
      arguments: { technology: "java" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Checkout");
  });
});

describe("create_request_attribute write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_request_attribute",
      arguments: { requestAttribute: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

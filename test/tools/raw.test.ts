import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRawTools } from "../../src/tools/raw.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const CLASSIC = "https://classic.example.com";

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: CLASSIC,
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerRawTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("raw_get", () => {
  it("GETs a platform path with repeated array query params", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get(`${PLATFORM}/platform/storage/filter-segments/v1/filter-segments/abc`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ uid: "abc", includes: [] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "raw_get",
      arguments: {
        host: "platform",
        path: "/platform/storage/filter-segments/v1/filter-segments/abc",
        query: { "add-fields": ["INCLUDES", "VARIABLES"] },
      },
    });
    expect(res.isError).toBeFalsy();
    expect(new URL(capturedUrl).searchParams.getAll("add-fields")).toEqual(["INCLUDES", "VARIABLES"]);
  });

  it("GETs a classic path", async () => {
    mswServer.use(
      http.get(`${CLASSIC}/api/v2/settings/schemas`, () => HttpResponse.json({ items: [], totalCount: 0 })),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "raw_get",
      arguments: { host: "classic", path: "/api/v2/settings/schemas" },
    });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toContain("totalCount");
  });

  it("rejects a path not starting with /", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "raw_get",
      arguments: { host: "platform", path: "platform/foo" },
    });
    expect(res.isError).toBe(true);
  });
});

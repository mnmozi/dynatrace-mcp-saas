import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerExtensionsTools } from "../../src/tools/extensions.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const EXT_BASE = `${PLATFORM}/platform/extensions/v2/extensions`;

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(EXT_BASE, () =>
    HttpResponse.json({
      items: [{ extensionName: "com.dynatrace.extension.foo", version: "1.0.0" }],
      totalCount: 1,
    }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerExtensionsTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_extensions", () => {
  it("returns extension list containing extensionName", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_extensions", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("com.dynatrace.extension.foo");
  });
});

describe("get_extension — encodeURIComponent", () => {
  it("encodes ':' characters in the extension name in the request URL", async () => {
    let capturedUrl = "";
    const encodedName = encodeURIComponent("com.dynatrace.extension.foo:bar");
    // Register handler for the encoded path
    mswServer.use(
      http.get(`${EXT_BASE}/${encodedName}`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ items: [], totalCount: 0 });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "get_extension",
      arguments: { extensionName: "com.dynatrace.extension.foo:bar" },
    });

    expect(res.isError).toBeFalsy();
    // The captured URL must contain the percent-encoded colon (%3A)
    expect(capturedUrl).toContain("%3A");
  });
});

describe("create_extension_monitoring_config — write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_extension_monitoring_config",
      arguments: { extensionName: "x", config: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

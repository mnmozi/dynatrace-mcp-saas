import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerEntitiesTools } from "../../src/tools/entities.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://p", classicUrl: "https://classic.example.com",
  platformToken: "P", apiToken: "A", enableWrites: false, timeoutMs: 5000,
};
const server = setupServer(
  http.get("https://classic.example.com/api/v2/entities", () =>
    HttpResponse.json({ entities: [{ entityId: "HOST-1", displayName: "web01" }], totalCount: 1 }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerEntitiesTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_hosts", () => {
  it("returns host entities", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("web01");
  });
});

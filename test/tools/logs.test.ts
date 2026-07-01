import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLogsTools } from "../../src/tools/logs.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://c",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

const server = setupServer(
  http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
    HttpResponse.json({ state: "SUCCEEDED", result: { records: [{ content: "boom", loglevel: "ERROR" }] } }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerLogsTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("search_logs", () => {
  it("returns records containing 'boom'", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "search_logs", arguments: { contains: "boom" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("boom");
  });

  it("uses a valid DQL now() timeframe (regression for DQL-SYNTAX-ERROR)", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "search_logs", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("from:now()-1h");
    expect(text).not.toContain("from:now-1h");
  });
});

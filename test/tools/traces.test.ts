import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTracesTools } from "../../src/tools/traces.js";
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
    HttpResponse.json({ state: "SUCCEEDED", result: { records: [{ "trace.id": "T1", "span.name": "GET /x" }] } }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerTracesTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("get_trace", () => {
  it("returns spans containing 'GET /x'", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_trace", arguments: { traceId: "T1" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("GET /x");
  });

  it("uses valid DQL now() timeframes (regression for DQL-SYNTAX-ERROR)", async () => {
    const client = await makeClient();
    const spans = await client.callTool({ name: "search_spans", arguments: {} });
    const spansText = (spans.content as Array<{ text: string }>)[0].text;
    expect(spansText).toContain("from:now()-1h");
    expect(spansText).not.toContain("from:now-1h");

    const trace = await client.callTool({ name: "get_trace", arguments: { traceId: "T1" } });
    const traceText = (trace.content as Array<{ text: string }>)[0].text;
    expect(traceText).toContain("from:now()-4h");
    expect(traceText).not.toContain("from:now-4h");
  });
});

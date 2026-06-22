import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerProblemsTools } from "../../src/tools/problems.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://p", classicUrl: "https://classic.example.com",
  platformToken: "P", apiToken: "A", enableWrites: false, timeoutMs: 5000,
};

let lastRequestUrl = "";

const server = setupServer(
  http.get("https://classic.example.com/api/v2/problems", ({ request }) => {
    lastRequestUrl = request.url;
    return HttpResponse.json({ problems: [{ problemId: "P-1", title: "High CPU" }], totalCount: 1 });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); lastRequestUrl = ""; });
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerProblemsTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_problems", () => {
  it("returns problem list containing High CPU", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_problems", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("High CPU");
  });
});

describe("list_problems pagination", () => {
  it("nextPageKey: URL contains only nextPageKey=P2 and no other filters", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "list_problems",
      arguments: { nextPageKey: "P2", problemSelector: 'status("OPEN")' },
    });
    expect(res.isError).toBeFalsy();
    const url = new URL(lastRequestUrl);
    expect(url.searchParams.get("nextPageKey")).toBe("P2");
    expect(url.searchParams.has("problemSelector")).toBe(false);
    expect(url.searchParams.has("from")).toBe(false);
    expect(url.searchParams.has("pageSize")).toBe(false);
  });
});

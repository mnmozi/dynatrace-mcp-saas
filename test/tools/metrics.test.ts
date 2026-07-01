import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMetricsTools } from "../../src/tools/metrics.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

const server = setupServer(
  // Default: list_metrics success (Gen2)
  http.get("https://classic.example.com/api/v2/metrics", () =>
    HttpResponse.json({ metrics: [{ metricId: "builtin:host.cpu.usage" }], totalCount: 1 }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerMetricsTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_metrics", () => {
  it("returns metric descriptors (Gen2 success)", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_metrics", arguments: { selector: "builtin:host.*" } });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("builtin:host.cpu.usage");
  });

  it("returns graceful fallback on 403 (Gen3 tenant missing metrics.read)", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/metrics", () =>
        HttpResponse.json(
          { error: { code: 403, message: "Token is missing required scope. Use one of: metrics.read" } },
          { status: 403 },
        ),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_metrics", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("metrics.read");
    expect(text).toContain("query_metric");
  });
});

describe("query_metric", () => {
  it("builds a DQL timeseries query and returns records", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json({
          state: "SUCCEEDED",
          result: {
            records: [{ "avg(dt.host.cpu.usage)": 12.3 }],
          },
        }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "query_metric",
      arguments: {
        metricKey: "dt.host.cpu.usage",
        by: ["dt.entity.host"],
        from: "now()-30m",
      },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("timeseries avg(dt.host.cpu.usage)");
    expect(text).toContain("by:{dt.entity.host}");
    expect(text).toContain("from:now()-30m");
    // recordCount should be 1
    expect(text).toContain('"recordCount": 1');
  });
});

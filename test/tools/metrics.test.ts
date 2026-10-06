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

  it("keeps Dynatrace's own 403 reason next to the Gen3 guidance", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/metrics", () =>
        HttpResponse.json({ error: { code: 403, message: "Token is disabled" } }, { status: 403 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_metrics", arguments: {} });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.unavailable).toBe(true);
    expect(body.dynatraceError).toContain("(classic /api/v2/metrics) — Token is disabled");
  });
});

describe("list_metrics — search (Grail metric catalog)", () => {
  const DQL_URL = "https://plat.example.com/platform/storage/query/v1/query:execute";
  const CLASSIC_METRICS_URL = "https://classic.example.com/api/v2/metrics";

  /** Answer every DQL execution with `records`, recording the queries that were sent. */
  function serveGrailRecords(records: Array<Record<string, unknown>>) {
    const queries: string[] = [];
    server.use(
      http.post(DQL_URL, async ({ request }) => {
        queries.push(((await request.json()) as { query: string }).query);
        return HttpResponse.json({ state: "SUCCEEDED", result: { records } });
      }),
    );
    return queries;
  }

  function denyClassicMetrics() {
    server.use(
      http.get(CLASSIC_METRICS_URL, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Token is missing required scope. Use one of: metrics.read" } },
          { status: 403 },
        ),
      ),
    );
  }

  /** Fail the test if the classic Metrics API is called at all. */
  function countClassicCalls() {
    const calls = { count: 0 };
    server.use(
      http.get(CLASSIC_METRICS_URL, () => {
        calls.count++;
        return HttpResponse.json({ metrics: [{ metricId: "builtin:host.cpu.usage" }], totalCount: 1 });
      }),
    );
    return calls;
  }

  async function listMetrics(args: Record<string, unknown>) {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_metrics", arguments: args });
    expect(res.isError).toBeFalsy();
    return JSON.parse((res.content as Array<{ text: string }>)[0].text);
  }

  it("searches metric keys in Grail, case-insensitively, without touching the classic API", async () => {
    const classicCalls = countClassicCalls();
    const queries = serveGrailRecords([{ "metric.key": "dt.host.cpu.idle", series: "10" }]);

    await listMetrics({ search: "host.cpu" });

    expect(queries).toEqual([
      'fetch metric.series | filter contains(metric.key, "host.cpu", caseSensitive:false) ' +
        "| summarize series = count(), by:{metric.key} | sort metric.key asc | limit 100",
    ]);
    expect(classicCalls.count).toBe(0);
  });

  it("returns the matching metric keys with the query that produced them", async () => {
    serveGrailRecords([
      { "metric.key": "dt.host.cpu.idle", series: "10" },
      { "metric.key": "dt.host.cpu.load", series: "9" },
    ]);

    const body = await listMetrics({ search: "host.cpu" });

    expect(body.source).toBe("grail");
    expect(body.recordCount).toBe(2);
    expect(body.records).toEqual([
      { "metric.key": "dt.host.cpu.idle", series: "10" },
      { "metric.key": "dt.host.cpu.load", series: "9" },
    ]);
    expect(body.query).toContain("fetch metric.series");
  });

  it("uses pageSize as the Grail row limit", async () => {
    const queries = serveGrailRecords([]);

    await listMetrics({ search: "cpu", pageSize: 25 });

    expect(queries[0]).toMatch(/\| limit 25$/);
  });

  it("escapes double quotes in the search text", async () => {
    const queries = serveGrailRecords([]);

    await listMetrics({ search: 'cpu"usage' });

    expect(queries[0]).toContain('contains(metric.key, "cpu\\"usage", caseSensitive:false)');
  });

  it("falls back to the Grail search when the classic selector is denied (403)", async () => {
    denyClassicMetrics();
    const queries = serveGrailRecords([{ "metric.key": "dt.host.cpu.idle", series: "10" }]);

    const body = await listMetrics({ selector: "builtin:host.cpu.*", search: "host.cpu" });

    expect(queries).toHaveLength(1);
    expect(body.source).toBe("grail");
    expect(body.records).toEqual([{ "metric.key": "dt.host.cpu.idle", series: "10" }]);
  });

  it("keeps Dynatrace's 403 reason in the fallback result", async () => {
    denyClassicMetrics();
    serveGrailRecords([]);

    const body = await listMetrics({ selector: "builtin:host.cpu.*", search: "host.cpu" });

    expect(body.dynatraceError).toContain("Token is missing required scope. Use one of: metrics.read");
  });

  it("answers from the classic API when the selector works, ignoring search", async () => {
    const classicCalls = countClassicCalls();
    const queries = serveGrailRecords([]);

    const body = await listMetrics({ selector: "builtin:host.cpu.*", search: "host.cpu" });

    expect(body.metrics).toEqual([{ metricId: "builtin:host.cpu.usage" }]);
    expect(classicCalls.count).toBe(1);
    expect(queries).toEqual([]);
  });

  it("does not translate a denied selector: it names search as the way to list metrics", async () => {
    denyClassicMetrics();
    const queries = serveGrailRecords([]);

    const body = await listMetrics({ selector: "builtin:host.cpu.*" });

    expect(body.unavailable).toBe(true);
    expect(body.useInstead).toContain("list_metrics with search");
    expect(queries).toEqual([]);
  });

  it("shows the generated query when Grail rejects the search", async () => {
    server.use(
      http.post(DQL_URL, () =>
        HttpResponse.json(
          { error: { code: 403, message: "Missing scope", details: { missingScopes: ["storage:metrics:read"] } } },
          { status: 403 },
        ),
      ),
    );
    const client = await makeClient();

    const res = await client.callTool({ name: "list_metrics", arguments: { search: "cpu" } });

    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("storage:metrics:read");
    expect(text).toContain("Generated DQL: fetch metric.series");
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

  it("appends the timeseries query it generated when Grail rejects it", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json(
          {
            error: {
              code: 400,
              message: "UNKNOWN_FUNCTION",
              details: {
                errorType: "UNKNOWN_FUNCTION",
                errorMessage: "There's no function `bogusagg`.",
                syntaxErrorPosition: {
                  start: { column: 12, index: 11, line: 1 },
                  end: { column: 19, index: 18, line: 1 },
                },
              },
            },
          },
          { status: 400 },
        ),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "query_metric",
      arguments: { metricKey: "dt.host.cpu.usage", aggregation: "bogusagg" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("There's no function `bogusagg`. [UNKNOWN_FUNCTION @ line 1, col 12]");
    expect(text).toContain("Generated DQL: timeseries bogusagg(dt.host.cpu.usage), from:now()-1h");
  });
});

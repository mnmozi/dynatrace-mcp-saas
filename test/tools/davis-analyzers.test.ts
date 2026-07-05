import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDavisAnalyzerTools } from "../../src/tools/davis-analyzers.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const BASE = `${PLATFORM}/platform/davis/analyzers/v1/analyzers`;
const FORECAST = "dt.statistics.GenericForecastAnalyzer";

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
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
  registerDavisAnalyzerTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

function text(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ text: string }>)[0].text;
}

describe("list_davis_analyzers", () => {
  it("returns the analyzer catalog", async () => {
    mswServer.use(http.get(BASE, () => HttpResponse.json({ analyzers: [{ name: FORECAST }], totalCount: 1 })));
    const client = await makeClient();
    const res = await client.callTool({ name: "list_davis_analyzers", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain(FORECAST);
  });
});

describe("get_davis_analyzer_input_schema", () => {
  it("fetches the input JSON schema", async () => {
    mswServer.use(
      http.get(`${BASE}/${FORECAST}/json-schema/input`, () =>
        HttpResponse.json({ type: "object", properties: { timeSeriesData: { type: "object" } } }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "get_davis_analyzer_input_schema",
      arguments: { name: FORECAST },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("timeSeriesData");
  });
});

describe("validate_davis_analyzer_input", () => {
  it("POSTs the input to :validate and returns the verdict", async () => {
    let captured: unknown = null;
    mswServer.use(
      http.post(`${BASE}/${FORECAST}\\:validate`, async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ valid: true });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "validate_davis_analyzer_input",
      arguments: { name: FORECAST, input: { timeSeriesData: { expression: "timeseries avg(dt.host.cpu.usage)" } } },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("true");
    expect((captured as Record<string, unknown>).timeSeriesData).toBeDefined();
  });
});

describe("execute_davis_analyzer", () => {
  it("validates first and does NOT execute when input is invalid", async () => {
    let executeCalled = false;
    mswServer.use(
      http.post(`${BASE}/${FORECAST}\\:validate`, () =>
        HttpResponse.json({ valid: false, details: { errorMessage: "query must not contain from:" } }),
      ),
      http.post(`${BASE}/${FORECAST}\\:execute`, () => {
        executeCalled = true;
        return HttpResponse.json({});
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "execute_davis_analyzer",
      arguments: { name: FORECAST, input: { timeSeriesData: { expression: "timeseries x, from:now()-1h" } } },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("must not contain from:");
    expect(text(res)).toContain('"executed": false');
    expect(executeCalled).toBe(false);
  });

  it("executes synchronously on HTTP 200 with a completed result", async () => {
    mswServer.use(
      http.post(`${BASE}/${FORECAST}\\:validate`, () => HttpResponse.json({ valid: true })),
      http.post(`${BASE}/${FORECAST}\\:execute`, () =>
        HttpResponse.json({
          result: { executionStatus: "COMPLETED", resultStatus: "SUCCESSFUL", output: [{ forecast: [1, 2, 3] }] },
        }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "execute_davis_analyzer",
      arguments: { name: FORECAST, input: { timeSeriesData: { expression: "timeseries avg(dt.host.cpu.usage)" } } },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain("SUCCESSFUL");
    expect(text(res)).toContain('"completed": true');
  });

  it("polls a long-running (202) execution until COMPLETED", async () => {
    let polls = 0;
    mswServer.use(
      http.post(`${BASE}/${FORECAST}\\:validate`, () => HttpResponse.json({ valid: true })),
      http.post(`${BASE}/${FORECAST}\\:execute`, () => HttpResponse.json({ requestToken: "tok-123" }, { status: 202 })),
      http.get(`${BASE}/${FORECAST}\\:poll`, ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("request-token")).toBe("tok-123");
        polls++;
        if (polls < 2) {
          return HttpResponse.json({ requestToken: "tok-123", result: { executionStatus: "RUNNING" } });
        }
        return HttpResponse.json({
          requestToken: "tok-123",
          result: { executionStatus: "COMPLETED", resultStatus: "SUCCESSFUL" },
        });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "execute_davis_analyzer",
      arguments: { name: FORECAST, input: { timeSeriesData: { expression: "timeseries avg(dt.host.cpu.usage)" } } },
    });
    expect(res.isError).toBeFalsy();
    expect(polls).toBe(2);
    expect(text(res)).toContain("COMPLETED");
    expect(text(res)).toContain('"completed": true');
  }, 15000);
});

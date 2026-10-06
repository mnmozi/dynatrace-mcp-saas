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

describe("get_trace_sampling_config", () => {
  const OBJECTS_URL = "https://c/api/v2/settings/objects";

  /** Serve one page of settings objects, recording each request's query string. */
  function serveObjects(items: unknown[]) {
    const queries: Array<Record<string, string>> = [];
    server.use(
      http.get(OBJECTS_URL, ({ request }) => {
        queries.push(Object.fromEntries(new URL(request.url).searchParams));
        return HttpResponse.json({ items });
      }),
    );
    return queries;
  }

  async function getSamplingConfig(args: Record<string, unknown> = {}) {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_trace_sampling_config", arguments: args });
    expect(res.isError).toBeFalsy();
    return JSON.parse((res.content as Array<{ text: string }>)[0].text);
  }

  it("asks for all four sampling schemas in a single request, at environment scope by default", async () => {
    const queries = serveObjects([]);

    const body = await getSamplingConfig();

    expect(queries).toHaveLength(1);
    expect(queries[0].schemaIds).toBe(
      "builtin:trace.ingest.control,builtin:global.trace.ingest.control,builtin:url-based-sampling,builtin:rpc-based-sampling",
    );
    expect(queries[0].scopes).toBe("environment");
    expect(body.scope).toBe("environment");
  });

  it("groups the objects by schema, keeping objectId and value", async () => {
    serveObjects([
      {
        objectId: "url-1",
        schemaId: "builtin:url-based-sampling",
        scope: "environment",
        value: { enabled: true, path: "/health", factor: "ReduceCapturingByFactor32" },
      },
      {
        objectId: "ingest-1",
        schemaId: "builtin:trace.ingest.control",
        scope: "environment",
        value: { enabled: true, samplingRatio: 4 },
      },
      {
        objectId: "url-2",
        schemaId: "builtin:url-based-sampling",
        scope: "environment",
        value: { enabled: false, path: "/metrics", ignore: true },
      },
    ]);

    const body = await getSamplingConfig();

    expect(body.schemas["builtin:url-based-sampling"]).toEqual([
      { objectId: "url-1", value: { enabled: true, path: "/health", factor: "ReduceCapturingByFactor32" } },
      { objectId: "url-2", value: { enabled: false, path: "/metrics", ignore: true } },
    ]);
    expect(body.schemas["builtin:trace.ingest.control"]).toEqual([
      { objectId: "ingest-1", value: { enabled: true, samplingRatio: 4 } },
    ]);
  });

  it("lists a schema with no objects as an empty array, so 'nothing set here' is explicit", async () => {
    serveObjects([]);

    const body = await getSamplingConfig();

    expect(body).toEqual({
      scope: "environment",
      objectCount: 0,
      schemas: {
        "builtin:trace.ingest.control": [],
        "builtin:global.trace.ingest.control": [],
        "builtin:url-based-sampling": [],
        "builtin:rpc-based-sampling": [],
      },
    });
  });

  it("reads the given scope instead when one is passed", async () => {
    const queries = serveObjects([]);

    const body = await getSamplingConfig({ scope: "PROCESS_GROUP-ABC" });

    expect(queries[0].scopes).toBe("PROCESS_GROUP-ABC");
    expect(body.scope).toBe("PROCESS_GROUP-ABC");
  });

  it("counts the objects found across all schemas", async () => {
    serveObjects([
      { objectId: "a", schemaId: "builtin:rpc-based-sampling", scope: "environment", value: {} },
      { objectId: "b", schemaId: "builtin:global.trace.ingest.control", scope: "environment", value: {} },
    ]);

    const body = await getSamplingConfig();

    expect(body.objectCount).toBe(2);
  });
});

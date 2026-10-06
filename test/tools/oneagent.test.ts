import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerOneAgentTools } from "../../src/tools/oneagent.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const OBJECTS_URL = "https://classic.example.com/api/v2/settings/objects";

const cfg: Config = {
  platformUrl: undefined,
  classicUrl: "https://classic.example.com",
  platformToken: undefined,
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
  maxRetries: 0,
  retryBaseMs: 1,
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function featureObject(objectId: string, value: Record<string, unknown>) {
  return { objectId, schemaId: "builtin:oneagent.features", scope: "environment", value };
}

const featureObjects = [
  featureObject("obj-sdk", { key: "SENSOR_SDK_JAVA_INCOMING_REMOTE_CALL", enabled: true, instrumentation: true }),
  featureObject("obj-sampling", { key: "JAVA_TRACE_SAMPLING_V2", enabled: false }),
  featureObject("obj-ims", { key: "SENSOR_ZAGENT_IMS_ITRA", enabled: true, instrumentation: false, forcible: true }),
];

/** Serve `pages` in order, recording each request's query string. */
function servePages(pages: Array<{ items: unknown[]; nextPageKey?: string }>) {
  const queries: Array<Record<string, string>> = [];
  server.use(
    http.get(OBJECTS_URL, ({ request }) => {
      queries.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json(pages[queries.length - 1]);
    }),
  );
  return queries;
}

async function listFeatures(args: Record<string, unknown> = {}) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerOneAgentTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  const res = await client.callTool({ name: "list_oneagent_features", arguments: args });
  expect(res.isError).toBeFalsy();
  return JSON.parse((res.content as Array<{ text: string }>)[0].text);
}

describe("list_oneagent_features", () => {
  it("returns every feature's key, flags and objectId, sorted by key", async () => {
    servePages([{ items: featureObjects }]);

    const body = await listFeatures();

    expect(body.features).toEqual([
      { key: "JAVA_TRACE_SAMPLING_V2", enabled: false, objectId: "obj-sampling" },
      { key: "SENSOR_SDK_JAVA_INCOMING_REMOTE_CALL", enabled: true, instrumentation: true, objectId: "obj-sdk" },
      { key: "SENSOR_ZAGENT_IMS_ITRA", enabled: true, instrumentation: false, forcible: true, objectId: "obj-ims" },
    ]);
  });

  it("reads the builtin:oneagent.features objects at environment scope by default", async () => {
    const queries = servePages([{ items: featureObjects }]);

    const body = await listFeatures();

    expect(queries[0].schemaIds).toBe("builtin:oneagent.features");
    expect(queries[0].scopes).toBe("environment");
    expect(body.scope).toBe("environment");
  });

  it("reads the given scope instead when one is passed", async () => {
    const queries = servePages([{ items: [] }]);

    const body = await listFeatures({ scope: "PROCESS_GROUP-ABC" });

    expect(queries[0].scopes).toBe("PROCESS_GROUP-ABC");
    expect(body).toEqual({
      scope: "PROCESS_GROUP-ABC",
      totalCount: 0,
      matchedCount: 0,
      truncated: false,
      features: [],
    });
  });

  it("keeps only the features whose key contains the query, ignoring case", async () => {
    servePages([{ items: featureObjects }]);

    const body = await listFeatures({ query: "sampling" });

    expect(body.features.map((f: { key: string }) => f.key)).toEqual(["JAVA_TRACE_SAMPLING_V2"]);
    expect(body.matchedCount).toBe(1);
    expect(body.totalCount).toBe(3);
  });

  it("collects the features of every page before filtering", async () => {
    servePages([
      { items: [featureObjects[0]], nextPageKey: "PAGE2" },
      { items: [featureObjects[1], featureObjects[2]] },
    ]);

    const body = await listFeatures({ query: "sensor" });

    expect(body.features.map((f: { key: string }) => f.key)).toEqual([
      "SENSOR_SDK_JAVA_INCOMING_REMOTE_CALL",
      "SENSOR_ZAGENT_IMS_ITRA",
    ]);
  });

  it("returns at most `limit` features and says the list was cut", async () => {
    servePages([{ items: featureObjects }]);

    const body = await listFeatures({ limit: 2 });

    expect(body.features.map((f: { key: string }) => f.key)).toEqual([
      "JAVA_TRACE_SAMPLING_V2",
      "SENSOR_SDK_JAVA_INCOMING_REMOTE_CALL",
    ]);
    expect(body.matchedCount).toBe(3);
    expect(body.truncated).toBe(true);
  });

  it("does not flag truncation when every match fits", async () => {
    servePages([{ items: featureObjects }]);

    const body = await listFeatures({ limit: 3 });

    expect(body.truncated).toBe(false);
  });
});

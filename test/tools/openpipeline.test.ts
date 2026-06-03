import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerOpenPipelineTools } from "../../src/tools/openpipeline.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(`${PLATFORM}/platform/openpipeline/v1/configurations`, () =>
    HttpResponse.json([{ id: "logs", editable: true }]),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerOpenPipelineTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_openpipeline_configurations", () => {
  it("returns configuration list containing 'logs'", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_openpipeline_configurations", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("logs");
  });
});

describe("get_openpipeline_configuration", () => {
  it("returns the config directly when GET-by-id works", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/openpipeline/v1/configurations/logs`, () =>
        HttpResponse.json({ id: "logs", editable: true, definition: { pipelines: ["p1"] } }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "get_openpipeline_configuration", arguments: { id: "logs" } });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toContain("p1");
  });

  it("falls back to the list when GET-by-id 404s (migration state)", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/openpipeline/v1/configurations/logs`, () =>
        HttpResponse.json({ error: { code: 404, message: "Migration in-progress/completed." } }, { status: 404 }),
      ),
      http.get(`${PLATFORM}/platform/openpipeline/v1/configurations`, () =>
        HttpResponse.json([
          { id: "events", editable: true, definition: {} },
          { id: "logs", editable: true, definition: { pipelines: ["from-list"] } },
        ]),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "get_openpipeline_configuration", arguments: { id: "logs" } });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toContain("from-list");
  });
});

describe("preview_openpipeline_processor", () => {
  it("returns preview result with processed record fields", async () => {
    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/preview/processor`, () =>
        HttpResponse.json({
          results: [{ matched: true, matchedProcessors: [], record: { "host.name": "raspberry-pi 4" } }],
        }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "preview_openpipeline_processor",
      arguments: {
        processor: {
          type: "fieldsRename",
          sampleData: '{"hostname":"raspberry-pi 4"}',
          fields: [{ fromName: "hostname", toName: "host.name" }],
        },
      },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("host.name");
  });
});

describe("update_openpipeline_configuration write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "update_openpipeline_configuration",
      arguments: { id: "logs", configuration: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

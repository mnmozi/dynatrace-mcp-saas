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

describe("preview_openpipeline_pipeline", () => {
  it("chains two processors: step 2 sees step 1's output record", async () => {
    // Each POST call reads sampleData from the posted body's processor, parses it,
    // adds a marker field keyed by the current field count, then returns it.
    // Call 1: { a: 1 } → has 1 field → adds step_1 → { a: 1, step_1: true }  (2 fields)
    // Call 2: { a: 1, step_1: true } → has 2 fields → adds step_2 → { a: 1, step_1: true, step_2: true }
    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/preview/processor`, async ({ request }) => {
        const body = await request.json() as { processor: { sampleData: string } };
        const parsed = JSON.parse(body.processor.sampleData) as Record<string, unknown>;
        const markerKey = `step_${Object.keys(parsed).length}`;
        const record = { ...parsed, [markerKey]: true };
        return HttpResponse.json({ results: [{ matched: true, record }] });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "preview_openpipeline_pipeline",
      arguments: {
        processors: [
          { id: "p1", type: "fieldsAdd" },
          { id: "p2", type: "fieldsAdd" },
        ],
        sampleData: { a: 1 },
      },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    const parsed = JSON.parse(text) as { steps: Array<{ matched: boolean; record: Record<string, unknown> }>; finalRecord: Record<string, unknown> };

    // Both steps must have run
    expect(parsed.steps).toHaveLength(2);

    // Step 1: initial record had 1 field → marker is step_1
    expect(parsed.steps[0].matched).toBe(true);
    expect(parsed.steps[0].record).toHaveProperty("step_1", true);

    // Step 2: must have received step 1's output (2 fields) → marker is step_2
    expect(parsed.steps[1].matched).toBe(true);
    expect(parsed.steps[1].record).toHaveProperty("step_2", true);

    // finalRecord reflects both transformations
    expect(parsed.finalRecord).toMatchObject({ a: 1, step_1: true, step_2: true });
  });
});

describe("list_openpipeline_processor_types", () => {
  it("returns all configs with stage processor types when called without configId", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/openpipeline/v1/configurations`, () =>
        HttpResponse.json([
          {
            id: "logs",
            definition: {
              pipelinesSpecification: { processing: ["fieldsAdd", "dql"] },
            },
          },
        ]),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "list_openpipeline_processor_types",
      arguments: {},
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("fieldsAdd");
  });

  it("filters by configId when provided", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/openpipeline/v1/configurations`, () =>
        HttpResponse.json([
          {
            id: "logs",
            definition: {
              pipelinesSpecification: { processing: ["fieldsAdd", "dql"] },
            },
          },
          {
            id: "events",
            definition: {
              pipelinesSpecification: { processing: ["drop"] },
            },
          },
        ]),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "list_openpipeline_processor_types",
      arguments: { configId: "logs" },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("fieldsAdd");
    // "events" config's processor type should not appear
    expect(text).not.toContain("drop");
  });
});

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

describe("preview_openpipeline_processor — passthrough acceptance", () => {
  it("preserves type-specific 'fields' array in the posted body (passthrough)", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/preview/processor`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          results: [{ matched: true, matchedProcessors: [], record: { "host.name": "raspberry-pi 4" } }],
        });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "preview_openpipeline_processor",
      arguments: {
        processor: {
          type: "fieldsRename",
          enabled: false,
          editable: true,
          id: "hostname-field-normalizer",
          description: "Renames hostname to host.name",
          matcher: 'isNotNull("hostname")',
          sampleData: '{"hostname":"raspberry-pi 4"}',
          // type-specific field — must pass through
          fields: [{ fromName: "hostname", toName: "host.name" }],
        },
      },
    });

    expect(res.isError).toBeFalsy();
    // The posted body wraps processor in { processor: … }
    const posted = capturedBody as { processor: Record<string, unknown> };
    expect(posted.processor.type).toBe("fieldsRename");
    expect(posted.processor.id).toBe("hostname-field-normalizer");
    // Critically: type-specific `fields` must be preserved by .passthrough()
    expect(Array.isArray(posted.processor.fields)).toBe(true);
    const fields = posted.processor.fields as Array<{ fromName: string; toName: string }>;
    expect(fields[0].fromName).toBe("hostname");
    expect(fields[0].toName).toBe("host.name");
  });
});

describe("preview_openpipeline_pipeline — passthrough acceptance", () => {
  it("preserves type-specific fields in each pipeline processor element", async () => {
    let capturedBodies: Array<unknown> = [];

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/preview/processor`, async ({ request }) => {
        const body = await request.json();
        capturedBodies.push(body);
        const b = body as { processor: { sampleData: string } };
        const parsed = JSON.parse(b.processor.sampleData) as Record<string, unknown>;
        const record = { ...parsed, processed: true };
        return HttpResponse.json({ results: [{ matched: true, record }] });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "preview_openpipeline_pipeline",
      arguments: {
        processors: [
          {
            type: "fieldsRename",
            id: "p1",
            matcher: "true",
            // type-specific field — must pass through
            fields: [{ fromName: "hostname", toName: "host.name" }],
          },
        ],
        sampleData: { hostname: "my-host" },
      },
    });

    expect(res.isError).toBeFalsy();
    expect(capturedBodies).toHaveLength(1);
    const first = capturedBodies[0] as { processor: Record<string, unknown> };
    expect(first.processor.type).toBe("fieldsRename");
    // fields must be preserved by .passthrough()
    expect(Array.isArray(first.processor.fields)).toBe(true);
  });
});

describe("verify_openpipeline_dql_processor — typed body acceptance", () => {
  it("sends script and optional fields to the verify endpoint", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/dqlProcessor/verify`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ valid: true, notifications: [] });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "verify_openpipeline_dql_processor",
      arguments: {
        body: {
          script: 'parse content, "IPV4:ip LD HTTPDATE:time \']\' LD:text"',
          configurationId: "logs",
          protectedFields: ["timestamp"],
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as { script: string; configurationId: string; protectedFields: string[] };
    expect(posted.script).toContain("parse content");
    expect(posted.configurationId).toBe("logs");
    expect(posted.protectedFields).toEqual(["timestamp"]);
  });
});

describe("verify_openpipeline_matcher — typed body acceptance", () => {
  it("sends query and optional fields to the verify endpoint", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/matcher/verify`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ valid: true, notifications: [] });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "verify_openpipeline_matcher",
      arguments: {
        body: {
          query: 'matchesValue(type, "security")',
          configurationId: "events",
          context: "processing",
          restrictedFields: ["content"],
          // extra field — must be preserved by passthrough
          extraField: "preserved",
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as Record<string, unknown>;
    expect(posted.query).toBe('matchesValue(type, "security")');
    expect(posted.configurationId).toBe("events");
    expect(posted.context).toBe("processing");
    expect(posted.restrictedFields).toEqual(["content"]);
    expect(posted.extraField).toBe("preserved");
  });
});

describe("convert_lql_to_dql — typed body acceptance", () => {
  it("sends query to the lqlToDql endpoint", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/matcher/lqlToDql`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ query: 'matchesValue(log.source, "snmptraps")' });
      }),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "convert_lql_to_dql",
      arguments: {
        body: {
          query: 'log.source="snmptraps" AND snmp.trap_oid="F5-BIGIP-COMMON-MIB"',
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as { query: string };
    expect(posted.query).toContain("snmptraps");
  });
});

describe("update_openpipeline_configuration — typed body acceptance", () => {
  it("preserves definition tree fields when using typed configuration schema", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.put(`${PLATFORM}/platform/openpipeline/v1/configurations/logs`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "logs" });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "update_openpipeline_configuration",
      arguments: {
        id: "logs",
        configuration: {
          id: "logs",
          editable: true,
          definition: {
            pipelinesSpecification: { processing: ["fieldsAdd"] },
            catchAllPipeline: { id: "default" },
          },
          // extra field — must be preserved by passthrough
          customField: "preserved",
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as Record<string, unknown>;
    expect(posted.id).toBe("logs");
    expect(posted.editable).toBe(true);
    expect(posted.customField).toBe("preserved");
    const def = posted.definition as Record<string, unknown>;
    expect(def.catchAllPipeline).toBeDefined();
  });
});

// ── update_openpipeline_configuration auto-verify guard ──────────────────────

/** A minimal config with one DQL processor and one matcher string */
const dqlAndMatcherConfig = {
  definition: {
    pipelines: [
      {
        id: "p1",
        processing: [
          {
            type: "dql",
            id: "proc1",
            dqlScript: "parse content, \"SIMPLE_TEXT:msg\"",
            matcher: "isNotNull(content)",
          },
        ],
      },
    ],
    routingRules: [
      {
        matcher: "matchesValue(type, \"logs\")",
        pipelineId: "p1",
      },
    ],
  },
};

describe("update_openpipeline_configuration — dryRun verifies, never PUTs", () => {
  it("returns valid:true with counts when all verify pass and dryRun=true", async () => {
    let putCalled = false;

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/dqlProcessor/verify`, () =>
        HttpResponse.json({ valid: true, notifications: [] }),
      ),
      http.post(`${PLATFORM}/platform/openpipeline/v1/matcher/verify`, () =>
        HttpResponse.json({ valid: true, notifications: [] }),
      ),
      http.put(`${PLATFORM}/platform/openpipeline/v1/configurations/logs`, () => {
        putCalled = true;
        return HttpResponse.json({ id: "logs" });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "update_openpipeline_configuration",
      arguments: { id: "logs", configuration: dqlAndMatcherConfig, dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    const result = JSON.parse(text) as { valid: boolean; verified: { dqlProcessors: number; matchers: number } };
    expect(result.valid).toBe(true);
    // 1 DQL processor, 2 matchers (one from the processor, one from routingRules)
    expect(result.verified.dqlProcessors).toBe(1);
    expect(result.verified.matchers).toBe(2);
    expect(putCalled).toBe(false);
  });
});

describe("update_openpipeline_configuration — invalid DQL → problems, no PUT", () => {
  it("returns valid:false with problems and does NOT PUT when DQL verify fails", async () => {
    let putCalled = false;

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/dqlProcessor/verify`, () =>
        HttpResponse.json({
          valid: false,
          notifications: [
            {
              severity: "ERROR",
              message: "There's been an error during parsing: There's no command `parsee`.",
            },
          ],
        }),
      ),
      http.post(`${PLATFORM}/platform/openpipeline/v1/matcher/verify`, () =>
        HttpResponse.json({ valid: true, notifications: [] }),
      ),
      http.put(`${PLATFORM}/platform/openpipeline/v1/configurations/logs`, () => {
        putCalled = true;
        return HttpResponse.json({ id: "logs" });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "update_openpipeline_configuration",
      arguments: { id: "logs", configuration: dqlAndMatcherConfig },
    });

    // Should NOT be an MCP-level error — returns a structured result
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    const result = JSON.parse(text) as { valid: boolean; problems: Array<{ kind: string; location: string }> };
    expect(result.valid).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.some((p) => p.kind === "dql")).toBe(true);
    expect(putCalled).toBe(false);
  });
});

describe("update_openpipeline_configuration — all valid + writes enabled → verify THEN PUT", () => {
  it("calls verify endpoints and then PUTs when all valid and writes enabled", async () => {
    let dqlVerifyCalled = false;
    let matcherVerifyCalled = false;
    let putCalled = false;

    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/dqlProcessor/verify`, () => {
        dqlVerifyCalled = true;
        return HttpResponse.json({ valid: true, notifications: [] });
      }),
      http.post(`${PLATFORM}/platform/openpipeline/v1/matcher/verify`, () => {
        matcherVerifyCalled = true;
        return HttpResponse.json({ valid: true, notifications: [] });
      }),
      http.put(`${PLATFORM}/platform/openpipeline/v1/configurations/logs`, () => {
        putCalled = true;
        return HttpResponse.json({ id: "logs", updated: true });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "update_openpipeline_configuration",
      arguments: { id: "logs", configuration: dqlAndMatcherConfig },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("updated");
    expect(dqlVerifyCalled).toBe(true);
    expect(matcherVerifyCalled).toBe(true);
    expect(putCalled).toBe(true);
  });
});

describe("update_openpipeline_configuration — writes disabled + dryRun false + all valid → write-gate blocks", () => {
  it("blocks with DT_ENABLE_WRITES after verify passes when writes disabled", async () => {
    mswServer.use(
      http.post(`${PLATFORM}/platform/openpipeline/v1/dqlProcessor/verify`, () =>
        HttpResponse.json({ valid: true, notifications: [] }),
      ),
      http.post(`${PLATFORM}/platform/openpipeline/v1/matcher/verify`, () =>
        HttpResponse.json({ valid: true, notifications: [] }),
      ),
    );

    // default cfg has enableWrites: false
    const client = await makeClient();
    const res = await client.callTool({
      name: "update_openpipeline_configuration",
      arguments: { id: "logs", configuration: dqlAndMatcherConfig },
    });

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("update_openpipeline_configuration — config with no DQL/matcher → zero verify calls, proceeds to PUT", () => {
  it("skips verify entirely and PUTs directly when no DQL processors or matchers", async () => {
    let putCalled = false;

    mswServer.use(
      http.put(`${PLATFORM}/platform/openpipeline/v1/configurations/logs`, () => {
        putCalled = true;
        return HttpResponse.json({ id: "logs" });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "update_openpipeline_configuration",
      arguments: {
        id: "logs",
        configuration: {
          id: "logs",
          editable: true,
          definition: { pipelinesSpecification: { processing: ["fieldsAdd"] } },
        },
      },
    });

    expect(res.isError).toBeFalsy();
    expect(putCalled).toBe(true);
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

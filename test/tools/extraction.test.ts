import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerExtractionTools } from "../../src/tools/extraction.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

// ─── shared config ────────────────────────────────────────────────────────────

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

// ─── fixture: the real-shaped bizevent rule ───────────────────────────────────

const ORDER_ATTEMPT_ITEM = {
  objectId: "obj-bizevent-1",
  value: {
    enabled: true,
    ruleName: "order-attempt-bizevent",
    triggers: [
      {
        source: { dataSource: "request.path" },
        type: "CONTAINS",
        value: "/orders",
        caseSensitive: false,
      },
      {
        source: { dataSource: "request.method" },
        type: "EQUALS",
        value: "POST",
      },
    ],
    event: {
      provider: { sourceType: "constant.string", source: "saas-demo-eks" },
      type: { sourceType: "constant.string", source: "order.attempt" },
      category: { sourceType: "constant.string", source: "checkout" },
      data: [
        {
          name: "http.status_code",
          source: { sourceType: "response.statusCode" },
        },
        {
          name: "order.total",
          source: { sourceType: "request.body", source: "$.total" },
        },
      ],
    },
  },
};

// ─── MSW server ───────────────────────────────────────────────────────────────

const server = setupServer(
  // happy-path bizevent settings
  http.get(
    "https://classic.example.com/api/v2/settings/objects",
    ({ request }) => {
      const url = new URL(request.url);
      const schema = url.searchParams.get("schemaIds");
      if (schema === "builtin:bizevents.http.incoming") {
        return HttpResponse.json({ items: [ORDER_ATTEMPT_ITEM] });
      }
      return HttpResponse.json({ items: [] });
    },
  ),
  // DQL execute (describe_log_fields)
  http.post(
    "https://plat.example.com/platform/storage/query/v1/query:execute",
    () =>
      HttpResponse.json({
        state: "SUCCEEDED",
        result: {
          records: [
            { parsed: { "order.id": 1, "order.total": 9 } },
            { parsed: { "order.id": 2, "payment.status": "OK" } },
          ],
        },
      }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ─── helper ───────────────────────────────────────────────────────────────────

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerExtractionTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

function getText(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ text: string }>)[0].text;
}

// ─── get_bizevent_capture_rules: happy path ───────────────────────────────────

describe("get_bizevent_capture_rules", () => {
  it("returns ruleName order-attempt-bizevent", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_bizevent_capture_rules", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = getText(res);
    expect(text).toContain("order-attempt-bizevent");
  });

  it("returns a trigger with dataSource request.path and value /orders", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_bizevent_capture_rules", arguments: {} });
    const text = getText(res);
    expect(text).toContain("request.path");
    expect(text).toContain("/orders");
  });

  it("returns event.type order.attempt", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_bizevent_capture_rules", arguments: {} });
    const parsed = JSON.parse(getText(res));
    const rule = parsed.rules[0];
    expect(rule.event.type).toBe("order.attempt");
  });

  it("includes field named order.total with sourceType request.body", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_bizevent_capture_rules", arguments: {} });
    const parsed = JSON.parse(getText(res));
    const rule = parsed.rules[0];
    const field = rule.fields.find((f: { name: string }) => f.name === "order.total");
    expect(field).toBeDefined();
    expect(field.sourceType).toBe("request.body");
    expect(field.source).toBe("$.total");
  });

  it("does not include raw by default", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_bizevent_capture_rules", arguments: {} });
    const parsed = JSON.parse(getText(res));
    expect(parsed.raw).toBeUndefined();
  });

  it("includes raw when includeRaw=true", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "get_bizevent_capture_rules",
      arguments: { includeRaw: true },
    });
    const parsed = JSON.parse(getText(res));
    expect(parsed.raw).toBeDefined();
    expect(parsed.raw.length).toBeGreaterThan(0);
  });
});

// ─── get_bizevent_capture_rules: graceful 403 ────────────────────────────────

describe("get_bizevent_capture_rules 403 graceful", () => {
  it("returns unavailable:true and is NOT isError", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/settings/objects", () =>
        HttpResponse.json({ error: { message: "Forbidden" } }, { status: 403 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "get_bizevent_capture_rules", arguments: {} });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res));
    expect(parsed.rules[0].unavailable).toBe(true);
    expect(parsed.rules[0].schemaId).toBe("builtin:bizevents.http.incoming");
  });
});

// ─── describe_log_fields ──────────────────────────────────────────────────────

describe("describe_log_fields", () => {
  it("discovers all field names across records", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "describe_log_fields",
      arguments: { filter: 'k8s.container.name == "api-gateway"' },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res));
    expect(parsed.discoveredFields).toContain("order.id");
    expect(parsed.discoveredFields).toContain("order.total");
    expect(parsed.discoveredFields).toContain("payment.status");
  });

  it("discoveredFields are sorted", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "describe_log_fields", arguments: {} });
    const parsed = JSON.parse(getText(res));
    const fields: string[] = parsed.discoveredFields;
    expect(fields).toEqual([...fields].sort());
  });

  it("built query contains parse content JSON:parsed clause", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "describe_log_fields", arguments: {} });
    const parsed = JSON.parse(getText(res));
    expect(parsed.query).toContain('parse content, "JSON:parsed"');
  });

  it("built query contains the filter expression when provided", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "describe_log_fields",
      arguments: { filter: 'k8s.container.name == "api-gateway"' },
    });
    const parsed = JSON.parse(getText(res));
    expect(parsed.query).toContain('k8s.container.name == "api-gateway"');
  });

  it("reports sampled count", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "describe_log_fields", arguments: {} });
    const parsed = JSON.parse(getText(res));
    expect(parsed.sampled).toBe(2);
  });

  it("includes up to 3 sample records", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "describe_log_fields", arguments: {} });
    const parsed = JSON.parse(getText(res));
    expect(parsed.samples.length).toBeLessThanOrEqual(3);
    expect(parsed.samples.length).toBeGreaterThan(0);
  });
});

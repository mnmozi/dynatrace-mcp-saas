import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIngestTools } from "../../src/tools/ingest.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const CLASSIC = "https://classic.example.com";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: CLASSIC,
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const writeCfg: Config = { ...cfg, enableWrites: true };

const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerIngestTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

// ── write-gate ──────────────────────────────────────────────────────────────

describe("ingest_events write-gate", () => {
  it("returns isError with DT_ENABLE_WRITES message when writes are disabled", async () => {
    const client = await makeClient(); // enableWrites: false
    const res = await client.callTool({
      name: "ingest_events",
      arguments: { event: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

// ── ingest_events success ────────────────────────────────────────────────────

describe("ingest_events success", () => {
  it("POSTs the event body and returns a non-error result; extra fields are preserved", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${CLASSIC}/api/v2/events/ingest`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "ingest_events",
      arguments: {
        event: {
          eventType: "CUSTOM_INFO",
          title: "t",
          extra: 1,
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as Record<string, unknown>;
    expect(posted.eventType).toBe("CUSTOM_INFO");
    expect(posted.title).toBe("t");
    expect(posted.extra).toBe(1);
  });
});

// ── ingest_logs array form ───────────────────────────────────────────────────

describe("ingest_logs array form", () => {
  it("POSTs a 2-element array to /api/v2/logs/ingest", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${CLASSIC}/api/v2/logs/ingest`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(undefined, { status: 204 });
      }),
    );

    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "ingest_logs",
      arguments: {
        logs: [{ content: "a" }, { content: "b" }],
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as Array<Record<string, unknown>>;
    expect(Array.isArray(posted)).toBe(true);
    expect(posted).toHaveLength(2);
    expect(posted[0].content).toBe("a");
    expect(posted[1].content).toBe("b");
  });
});

const txt = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

// ── ingest_bizevents content-type (the bug fix) ──────────────────────────────

describe("ingest_bizevents content-type", () => {
  it("default (no cloudEvent) sends application/json with literal keys passed through", async () => {
    let ct = "";
    let body: unknown;
    mswServer.use(
      http.post(`${CLASSIC}/api/v2/bizevents/ingest`, async ({ request }) => {
        ct = request.headers.get("content-type") ?? "";
        body = await request.json();
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "ingest_bizevents",
      arguments: { bizevent: { "event.type": "order.attempt", "event.provider": "checkout", amount: 42 } },
    });
    expect(res.isError).toBeFalsy();
    expect(ct).toContain("application/json");
    expect((body as Record<string, unknown>)["event.type"]).toBe("order.attempt");
  });

  it("cloudEvent:true (single) sends application/cloudevent+json", async () => {
    let ct = "";
    mswServer.use(
      http.post(`${CLASSIC}/api/v2/bizevents/ingest`, ({ request }) => {
        ct = request.headers.get("content-type") ?? "";
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    const client = await makeClient(writeCfg);
    await client.callTool({
      name: "ingest_bizevents",
      arguments: { bizevent: { specversion: "1.0", source: "checkout", type: "order.attempt", id: "1" }, cloudEvent: true },
    });
    expect(ct).toContain("application/cloudevent+json");
  });

  it("cloudEvent:true with an array sends the batch content-type", async () => {
    let ct = "";
    mswServer.use(
      http.post(`${CLASSIC}/api/v2/bizevents/ingest`, ({ request }) => {
        ct = request.headers.get("content-type") ?? "";
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    const client = await makeClient(writeCfg);
    await client.callTool({
      name: "ingest_bizevents",
      arguments: { bizevent: [{ specversion: "1.0", source: "s", type: "t", id: "1" }], cloudEvent: true },
    });
    expect(ct).toContain("application/cloudevents-batch+json");
  });
});

// ── ingest_openpipeline_events (platform ingest) ─────────────────────────────

describe("ingest_openpipeline_events", () => {
  it("posts to the platform /platform/ingest/v1/events endpoint for dataType=events", async () => {
    let hit = "";
    let body: unknown;
    mswServer.use(
      http.post(`${CLASSIC}/platform/ingest/v1/events`, async ({ request }) => {
        hit = new URL(request.url).pathname;
        body = await request.json();
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "ingest_openpipeline_events",
      arguments: { dataType: "events", events: { "event.type": "deploy" } },
    });
    expect(res.isError).toBeFalsy();
    expect(hit).toBe("/platform/ingest/v1/events");
    expect((body as Record<string, unknown>)["event.type"]).toBe("deploy");
  });

  it("maps dataType=sdlc to /platform/ingest/v1/events.sdlc", async () => {
    let hit = "";
    mswServer.use(
      http.post(`${CLASSIC}/platform/ingest/v1/events.sdlc`, ({ request }) => {
        hit = new URL(request.url).pathname;
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    const client = await makeClient(writeCfg);
    await client.callTool({ name: "ingest_openpipeline_events", arguments: { dataType: "sdlc", events: {} } });
    expect(hit).toBe("/platform/ingest/v1/events.sdlc");
  });

  it("routes to a custom endpoint under the dataType's category", async () => {
    let hit = "";
    mswServer.use(
      http.post(`${CLASSIC}/platform/ingest/custom/security.events/my-scanner`, ({ request }) => {
        hit = new URL(request.url).pathname;
        return HttpResponse.json({}, { status: 202 });
      }),
    );
    const client = await makeClient(writeCfg);
    await client.callTool({
      name: "ingest_openpipeline_events",
      arguments: { dataType: "security", events: {}, customEndpoint: "my-scanner" },
    });
    expect(hit).toBe("/platform/ingest/custom/security.events/my-scanner");
  });

  it("errors when a custom endpoint is requested for smartscape (no custom category)", async () => {
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "ingest_openpipeline_events",
      arguments: { dataType: "smartscape", events: {}, customEndpoint: "x" },
    });
    expect(res.isError).toBe(true);
    expect(txt(res)).toMatch(/not supported/i);
  });

  it("is write-gated", async () => {
    const client = await makeClient(); // enableWrites: false
    const res = await client.callTool({
      name: "ingest_openpipeline_events",
      arguments: { dataType: "events", events: {} },
    });
    expect(res.isError).toBe(true);
    expect(txt(res)).toMatch(/DT_ENABLE_WRITES/);
  });
});

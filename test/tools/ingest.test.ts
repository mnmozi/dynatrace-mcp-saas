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

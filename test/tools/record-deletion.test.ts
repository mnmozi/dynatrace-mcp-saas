import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerRecordDeletionTools } from "../../src/tools/record-deletion.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const BASE = `${PLATFORM}/platform/storage/record/v1`;

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.post(`${BASE}/delete:status`, () =>
    HttpResponse.json({
      status: "processing",
      progress: "42%",
    }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerRecordDeletionTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("get_record_deletion_status", () => {
  it("returns status object containing the status field", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "get_record_deletion_status",
      arguments: { taskId: "49eb7d8e-806a-4829-9d29-c2a92e642366" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("processing");
    expect(text).toContain("42%");
  });
});

describe("execute_record_deletion write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "execute_record_deletion",
      arguments: {
        query: 'fetch logs | filter contains(content, "test")',
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("execute_record_deletion", () => {
  it("POSTs query and returns taskId when writes are enabled", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${BASE}/delete:execute`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ taskId: "abc-123" }, { status: 202 });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "execute_record_deletion",
      arguments: {
        query: 'fetch logs | filter contains(content, "delete_records_test")',
        timeFrame: { start: "2023-04-04T00:00:00Z", end: "2023-04-04T01:00:00Z" },
        timezone: "UTC",
        locale: "en-US",
      },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("abc-123");

    const body = capturedBody as Record<string, unknown>;
    expect(body.query).toContain("delete_records_test");
    expect((body.timeFrame as Record<string, string>).start).toBe("2023-04-04T00:00:00Z");
  });
});

describe("cancel_record_deletion write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "cancel_record_deletion",
      arguments: { taskId: "49eb7d8e-806a-4829-9d29-c2a92e642366" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("cancel_record_deletion", () => {
  it("POSTs taskId and returns response when writes are enabled", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${BASE}/delete:cancel`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ taskId: "49eb7d8e-806a-4829-9d29-c2a92e642366" }, { status: 202 });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "cancel_record_deletion",
      arguments: { taskId: "49eb7d8e-806a-4829-9d29-c2a92e642366" },
    });

    expect(res.isError).toBeFalsy();
    const body = capturedBody as Record<string, string>;
    expect(body.taskId).toBe("49eb7d8e-806a-4829-9d29-c2a92e642366");
  });
});

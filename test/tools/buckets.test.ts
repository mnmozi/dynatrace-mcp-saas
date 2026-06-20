import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerBucketTools } from "../../src/tools/buckets.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const BASE = `${PLATFORM}/platform/storage/management/v1`;

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(`${BASE}/bucket-definitions`, () =>
    HttpResponse.json({
      buckets: [{ bucketName: "default_logs", table: "logs", retentionDays: 35 }],
    }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerBucketTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_grail_buckets", () => {
  it("returns bucket list containing bucketName", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_grail_buckets", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("default_logs");
  });
});

describe("get_grail_bucket", () => {
  it("fetches a single bucket by name", async () => {
    mswServer.use(
      http.get(`${BASE}/bucket-definitions/my_bucket`, () =>
        HttpResponse.json({ bucketName: "my_bucket", table: "logs", retentionDays: 10 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "get_grail_bucket",
      arguments: { bucketName: "my_bucket" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("my_bucket");
  });
});

describe("create_grail_bucket write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_grail_bucket",
      arguments: { bucket: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("create_grail_bucket — write enabled", () => {
  it("POSTs bucket body and returns created bucket", async () => {
    let capturedBody: unknown = null;
    mswServer.use(
      http.post(`${BASE}/bucket-definitions`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          { bucketName: "custom_logs", table: "logs", status: "creating", retentionDays: 35, version: 1 },
          { status: 201 },
        );
      }),
    );
    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "create_grail_bucket",
      arguments: { bucket: { bucketName: "custom_logs", table: "logs", retentionDays: 35 } },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("custom_logs");
    const body = capturedBody as Record<string, unknown>;
    expect(body.bucketName).toBe("custom_logs");
    expect(body.table).toBe("logs");
    expect(body.retentionDays).toBe(35);
  });
});

describe("update_grail_bucket write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "update_grail_bucket",
      arguments: { bucketName: "custom_logs", bucket: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("delete_grail_bucket write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "delete_grail_bucket",
      arguments: { bucketName: "custom_logs" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("delete_grail_bucket — write enabled", () => {
  it("sends DELETE request and returns success", async () => {
    mswServer.use(
      http.delete(`${BASE}/bucket-definitions/custom_logs`, () =>
        HttpResponse.json({ bucketName: "custom_logs", status: "deleting" }, { status: 202 }),
      ),
    );
    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "delete_grail_bucket",
      arguments: { bucketName: "custom_logs" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("deleting");
  });
});

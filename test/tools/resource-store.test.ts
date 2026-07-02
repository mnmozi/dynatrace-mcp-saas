import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerResourceStoreTools } from "../../src/tools/resource-store.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const BASE = `${PLATFORM}/platform/storage/resource-store/v1`;

const CSV = "svc-a,team-red\nsvc-b,team-blue";
const PATTERN = "LD:id ',' LD:owner EOL"; // live-verified DPL shape for CSV columns

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerResourceStoreTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

/** Parse the multipart form of a captured request into its `request` JSON and `content` text parts. */
async function readForm(request: Request): Promise<{ meta: Record<string, unknown>; content: string }> {
  const form = await request.formData();
  const metaPart = form.get("request") as Blob;
  const contentPart = form.get("content") as Blob;
  return {
    meta: JSON.parse(await metaPart.text()) as Record<string, unknown>,
    content: await contentPart.text(),
  };
}

describe("test_lookup_pattern", () => {
  it("POSTs multipart with request metadata + content, no write gate", async () => {
    let captured: { meta: Record<string, unknown>; content: string } | null = null;
    mswServer.use(
      http.post(`${BASE}/files/tabular/lookup:test-pattern`, async ({ request }) => {
        captured = await readForm(request);
        return HttpResponse.json({ records: [{ id: "svc-a", owner: "team-red" }] });
      }),
    );
    const client = await makeClient(); // writes disabled — must still work
    const res = await client.callTool({
      name: "test_lookup_pattern",
      arguments: { content: CSV, parsePattern: PATTERN, lookupField: "id" },
    });
    expect(res.isError).toBeFalsy();
    expect((res.content as Array<{ text: string }>)[0].text).toContain("team-red");
    expect(captured!.meta.lookupField).toBe("id");
    expect(captured!.content).toBe(CSV);
  });
});

describe("upload_lookup_data", () => {
  it("dryRun verifies via test-pattern only and does NOT hit upload (no write gate)", async () => {
    let testPatternCalls = 0;
    mswServer.use(
      http.post(`${BASE}/files/tabular/lookup:test-pattern`, () => {
        testPatternCalls++;
        return HttpResponse.json({ records: [{ id: "svc-a" }] });
      }),
      // NOTE: no handler for lookup:upload — hitting it would fail via onUnhandledRequest:"error"
    );
    const client = await makeClient(); // writes disabled
    const res = await client.callTool({
      name: "upload_lookup_data",
      arguments: { content: CSV, parsePattern: PATTERN, filePath: "/lookups/owners", dryRun: true },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("dryRun");
    expect(testPatternCalls).toBe(1);
  });

  it("is write-gated after a successful verify", async () => {
    mswServer.use(http.post(`${BASE}/files/tabular/lookup:test-pattern`, () => HttpResponse.json({ records: [] })));
    const client = await makeClient(); // writes disabled
    const res = await client.callTool({
      name: "upload_lookup_data",
      arguments: { content: CSV, parsePattern: PATTERN, filePath: "/lookups/owners" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });

  it("verifies then uploads, forwarding metadata to the upload part", async () => {
    const calls: string[] = [];
    let uploadMeta: Record<string, unknown> | null = null;
    mswServer.use(
      http.post(`${BASE}/files/tabular/lookup:test-pattern`, () => {
        calls.push("test-pattern");
        return HttpResponse.json({ records: [{ id: "svc-a" }] });
      }),
      http.post(`${BASE}/files/tabular/lookup:upload`, async ({ request }) => {
        calls.push("upload");
        uploadMeta = (await readForm(request)).meta;
        return HttpResponse.json({ filePath: "/lookups/owners", status: "CREATED" });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "upload_lookup_data",
      arguments: {
        content: CSV,
        parsePattern: PATTERN,
        filePath: "/lookups/owners",
        lookupField: "id",
        displayName: "Owners",
      },
    });
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(["test-pattern", "upload"]); // verify ALWAYS runs before upload
    expect(uploadMeta!.filePath).toBe("/lookups/owners");
    expect(uploadMeta!.lookupField).toBe("id");
    expect(uploadMeta!.displayName).toBe("Owners");
    expect((res.content as Array<{ text: string }>)[0].text).toContain("CREATED");
  });

  it("does NOT upload when the online verify rejects the content", async () => {
    let uploadCalled = false;
    mswServer.use(
      http.post(`${BASE}/files/tabular/lookup:test-pattern`, () =>
        HttpResponse.json(
          { error: { code: 400, message: "Parse failed: pattern did not match line 1" } },
          { status: 400 },
        ),
      ),
      http.post(`${BASE}/files/tabular/lookup:upload`, () => {
        uploadCalled = true;
        return HttpResponse.json({});
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "upload_lookup_data",
      arguments: { content: "garbage", parsePattern: PATTERN, filePath: "/lookups/owners" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("Parse failed");
    expect(uploadCalled).toBe(false);
  });
});

describe("delete_resource_file", () => {
  it("is write-gated", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "delete_resource_file", arguments: { filePath: "/lookups/x" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });

  it("POSTs files:delete with the filePath when writes are enabled", async () => {
    let capturedBody: unknown = null;
    mswServer.use(
      http.post(`${BASE}/files:delete`, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({ name: "delete_resource_file", arguments: { filePath: "/lookups/x" } });
    expect(res.isError).toBeFalsy();
    expect((capturedBody as Record<string, unknown>).filePath).toBe("/lookups/x");
  });
});

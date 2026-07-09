import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFilterSegmentTools } from "../../src/tools/filter-segments.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";
const BASE = `${PLATFORM}/platform/storage/filter-segments/v1`;

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(`${BASE}/filter-segments`, () =>
    HttpResponse.json({ filterSegments: [{ uid: "seg-1", name: "Prod only" }] }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerFilterSegmentTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_filter_segments", () => {
  it("returns filter segment list containing the segment name", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_filter_segments", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Prod only");
  });
});

describe("create_filter_segment write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_filter_segment",
      arguments: { filterSegment: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("get_filter_segment", () => {
  it("requests add-fields=INCLUDES,VARIABLES by default so the definition is returned", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get(`${BASE}/filter-segments/seg-1`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ uid: "seg-1", name: "Prod only", includes: [{ filter: 'env == "prod"' }] });
      }),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "get_filter_segment", arguments: { uid: "seg-1" } });
    expect(res.isError).toBeFalsy();
    const params = new URL(capturedUrl).searchParams.getAll("add-fields");
    expect(params).toEqual(["INCLUDES", "VARIABLES"]);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("includes");
  });

  it("honours an explicit addFields override (empty = metadata only)", async () => {
    let capturedUrl = "";
    mswServer.use(
      http.get(`${BASE}/filter-segments/seg-1`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ uid: "seg-1", name: "Prod only" });
      }),
    );
    const client = await makeClient();
    await client.callTool({ name: "get_filter_segment", arguments: { uid: "seg-1", addFields: [] } });
    expect(new URL(capturedUrl).searchParams.getAll("add-fields")).toEqual([]);
  });
});

describe("update_filter_segment", () => {
  it("sends the required optimistic-locking-version as a QUERY parameter", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    mswServer.use(
      http.put(`${BASE}/filter-segments/seg-1`, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const client = await makeClient({ ...cfg, enableWrites: true });
    const res = await client.callTool({
      name: "update_filter_segment",
      arguments: { uid: "seg-1", version: 3, filterSegment: { name: "Prod only", isPublic: false } },
    });
    expect(res.isError).toBeFalsy();
    expect(new URL(capturedUrl).searchParams.get("optimistic-locking-version")).toBe("3");
    expect((capturedBody as Record<string, unknown>).name).toBe("Prod only");
  });
});

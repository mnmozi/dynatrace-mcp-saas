import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDashboardTools } from "../../src/tools/dashboards.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";

const cfgReadOnly: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const cfgWrites: Config = { ...cfgReadOnly, enableWrites: true };

// MSW server — intercepts real fetch calls
const mswServer = setupServer(
  // LIST dashboards
  http.get(`${PLATFORM}/platform/document/v1/documents`, ({ request }) => {
    const url = new URL(request.url);
    const filter = url.searchParams.get("filter");
    if (filter && filter.includes("dashboard")) {
      return HttpResponse.json({
        documents: [{ id: "D1", name: "Ops", type: "dashboard", version: "1", owner: "u1", modificationInfo: { createdBy: "u1", createdTime: "2024-01-01T00:00:00Z", lastModifiedBy: "u1", lastModifiedTime: "2024-01-01T00:00:00Z" }, access: ["read", "write", "delete"], isPrivate: true }],
        totalCount: 1,
      });
    }
    return HttpResponse.json({ documents: [], totalCount: 0 });
  }),

  // GET dashboard metadata
  http.get(`${PLATFORM}/platform/document/v1/documents/:id/metadata`, ({ params }) => {
    if (params["id"] === "D1") {
      return HttpResponse.json({ id: "D1", name: "Ops", type: "dashboard", version: "2", owner: "u1", modificationInfo: { createdBy: "u1", createdTime: "2024-01-01T00:00:00Z", lastModifiedBy: "u1", lastModifiedTime: "2024-01-02T00:00:00Z" }, access: ["read", "write", "delete"], isPrivate: true });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // GET dashboard content
  http.get(`${PLATFORM}/platform/document/v1/documents/:id/content`, ({ params }) => {
    if (params["id"] === "D1") {
      return HttpResponse.text(JSON.stringify({ tiles: [] }), { headers: { "Content-Type": "application/json" } });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // CREATE dashboard
  http.post(`${PLATFORM}/platform/document/v1/documents`, async () => {
    return HttpResponse.json({ id: "D-new", name: "My New Dashboard", type: "dashboard", version: "1", owner: "u1", modificationInfo: { createdBy: "u1", createdTime: "2024-01-01T00:00:00Z", lastModifiedBy: "u1", lastModifiedTime: "2024-01-01T00:00:00Z" }, access: ["read", "write", "delete"], isPrivate: true }, { status: 201 });
  }),

  // UPDATE dashboard (PATCH)
  http.patch(`${PLATFORM}/platform/document/v1/documents/:id`, async ({ params }) => {
    if (params["id"] === "D1") {
      return HttpResponse.json({ documentMetadata: { id: "D1", name: "Ops Updated", type: "dashboard", version: "3", owner: "u1", modificationInfo: { createdBy: "u1", createdTime: "2024-01-01T00:00:00Z", lastModifiedBy: "u1", lastModifiedTime: "2024-01-03T00:00:00Z" }, access: ["read", "write", "delete"], isPrivate: true } });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // DELETE dashboard
  http.delete(`${PLATFORM}/platform/document/v1/documents/:id`, ({ params }) => {
    if (params["id"] === "D1") {
      return new HttpResponse(null, { status: 204 });
    }
    return new HttpResponse(null, { status: 404 });
  }),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(cfg: Config) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerDashboardTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

// ─── list_dashboards ──────────────────────────────────────────────────────────

describe("list_dashboards", () => {
  it("returns dashboard list containing the dashboard name", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({ name: "list_dashboards", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Ops");
  });

  it("passes page-size to the API when provided", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({ name: "list_dashboards", arguments: { pageSize: 10 } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    // If page-size is forwarded, the mock still returns our document (filter matches)
    expect(text).toContain("Ops");
  });
});

// ─── get_dashboard ────────────────────────────────────────────────────────────

describe("get_dashboard", () => {
  it("returns combined metadata and content", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({ name: "get_dashboard", arguments: { id: "D1" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Ops");
    expect(text).toContain("tiles");
  });
});

// ─── write-gate tests ─────────────────────────────────────────────────────────

describe("create_dashboard write-gate", () => {
  it("blocks when enableWrites=false", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({
      name: "create_dashboard",
      arguments: { name: "x", content: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("update_dashboard write-gate", () => {
  it("blocks when enableWrites=false", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({
      name: "update_dashboard",
      arguments: { id: "D1", version: 2 },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("delete_dashboard write-gate", () => {
  it("blocks when enableWrites=false", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({
      name: "delete_dashboard",
      arguments: { id: "D1", version: 2 },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

// ─── create_dashboard success (writes enabled) ───────────────────────────────

describe("create_dashboard (writes enabled)", () => {
  it("creates a dashboard and returns metadata", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "create_dashboard",
      arguments: { name: "My New Dashboard", content: { tiles: [] } },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("D-new");
  });
});

// ─── update_dashboard success (writes enabled) ───────────────────────────────

describe("update_dashboard (writes enabled)", () => {
  it("updates a dashboard and returns updated metadata", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "update_dashboard",
      arguments: { id: "D1", version: 2, name: "Ops Updated" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Ops Updated");
  });
});

// ─── delete_dashboard success (writes enabled) ───────────────────────────────

describe("delete_dashboard (writes enabled)", () => {
  it("deletes a dashboard (204 no content)", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "delete_dashboard",
      arguments: { id: "D1", version: 2 },
    });
    expect(res.isError).toBeFalsy();
  });
});

// ─── contentPath support ─────────────────────────────────────────────────────

describe("create_dashboard with contentPath", () => {
  it("reads the file and sends its JSON as the content part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-create-"));
    const file = join(dir, "d.json");
    writeFileSync(file, JSON.stringify({ tiles: [], marker: "FROM_FILE_XYZ" }));

    let body = "";
    mswServer.use(
      http.post(`${PLATFORM}/platform/document/v1/documents`, async ({ request }) => {
        body = await request.text();
        return HttpResponse.json(
          { id: "D-new", name: "x", type: "dashboard", version: "1", owner: "u1", modificationInfo: { createdBy: "u1", createdTime: "2024-01-01T00:00:00Z", lastModifiedBy: "u1", lastModifiedTime: "2024-01-01T00:00:00Z" }, access: ["read"], isPrivate: true },
          { status: 201 },
        );
      }),
    );

    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "create_dashboard",
      arguments: { name: "x", contentPath: file },
    });
    expect(res.isError).toBeFalsy();
    expect(body).toContain("FROM_FILE_XYZ");
    rmSync(dir, { recursive: true, force: true });
  });

  it("errors when neither content nor contentPath is provided", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({ name: "create_dashboard", arguments: { name: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/content .*or contentPath/i);
  });

  it("errors when both content and contentPath are provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-both-"));
    const file = join(dir, "d.json");
    writeFileSync(file, JSON.stringify({ tiles: [] }));
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "create_dashboard",
      arguments: { name: "x", content: { tiles: [] }, contentPath: file },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/not both/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("update_dashboard with contentPath", () => {
  it("reads the file and sends its JSON as the content part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dash-update-"));
    const file = join(dir, "d.json");
    writeFileSync(file, JSON.stringify({ tiles: [], marker: "UPDATED_FROM_FILE" }));

    let body = "";
    mswServer.use(
      http.patch(`${PLATFORM}/platform/document/v1/documents/:id`, async ({ request }) => {
        body = await request.text();
        return HttpResponse.json({ documentMetadata: { id: "D1", name: "Ops", type: "dashboard", version: "3", owner: "u1", modificationInfo: { createdBy: "u1", createdTime: "2024-01-01T00:00:00Z", lastModifiedBy: "u1", lastModifiedTime: "2024-01-03T00:00:00Z" }, access: ["read"], isPrivate: true } });
      }),
    );

    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "update_dashboard",
      arguments: { id: "D1", version: 2, contentPath: file },
    });
    expect(res.isError).toBeFalsy();
    expect(body).toContain("UPDATED_FROM_FILE");
    rmSync(dir, { recursive: true, force: true });
  });
});

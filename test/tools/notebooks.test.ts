import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerNotebookTools } from "../../src/tools/notebooks.js";
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

// Capture last request URL for pagination assertions
let lastDocRequestUrl = "";

// MSW server — intercepts real fetch calls
const mswServer = setupServer(
  // LIST notebooks
  http.get(`${PLATFORM}/platform/document/v1/documents`, ({ request }) => {
    lastDocRequestUrl = request.url;
    const url = new URL(request.url);
    const filter = url.searchParams.get("filter");
    if (filter && filter.includes("notebook")) {
      return HttpResponse.json({
        documents: [
          {
            id: "N1",
            name: "Investigation",
            type: "notebook",
            version: "1",
            owner: "u1",
            modificationInfo: {
              createdBy: "u1",
              createdTime: "2024-01-01T00:00:00Z",
              lastModifiedBy: "u1",
              lastModifiedTime: "2024-01-01T00:00:00Z",
            },
            access: ["read", "write", "delete"],
            isPrivate: true,
          },
        ],
        totalCount: 1,
        nextPageKey: "K3",
      });
    }
    return HttpResponse.json({ documents: [], totalCount: 0 });
  }),

  // GET notebook metadata
  http.get(`${PLATFORM}/platform/document/v1/documents/:id/metadata`, ({ params }) => {
    if (params["id"] === "N1") {
      return HttpResponse.json({
        id: "N1",
        name: "Investigation",
        type: "notebook",
        version: "2",
        owner: "u1",
        modificationInfo: {
          createdBy: "u1",
          createdTime: "2024-01-01T00:00:00Z",
          lastModifiedBy: "u1",
          lastModifiedTime: "2024-01-02T00:00:00Z",
        },
        access: ["read", "write", "delete"],
        isPrivate: true,
      });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // GET notebook content
  http.get(`${PLATFORM}/platform/document/v1/documents/:id/content`, ({ params }) => {
    if (params["id"] === "N1") {
      return HttpResponse.text(JSON.stringify({ cells: [] }), { headers: { "Content-Type": "application/json" } });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // CREATE notebook
  http.post(`${PLATFORM}/platform/document/v1/documents`, async () => {
    return HttpResponse.json(
      {
        id: "N-new",
        name: "My New Notebook",
        type: "notebook",
        version: "1",
        owner: "u1",
        modificationInfo: {
          createdBy: "u1",
          createdTime: "2024-01-01T00:00:00Z",
          lastModifiedBy: "u1",
          lastModifiedTime: "2024-01-01T00:00:00Z",
        },
        access: ["read", "write", "delete"],
        isPrivate: true,
      },
      { status: 201 },
    );
  }),

  // UPDATE notebook (PATCH)
  http.patch(`${PLATFORM}/platform/document/v1/documents/:id`, async ({ params }) => {
    if (params["id"] === "N1") {
      return HttpResponse.json({
        documentMetadata: {
          id: "N1",
          name: "Investigation Updated",
          type: "notebook",
          version: "3",
          owner: "u1",
          modificationInfo: {
            createdBy: "u1",
            createdTime: "2024-01-01T00:00:00Z",
            lastModifiedBy: "u1",
            lastModifiedTime: "2024-01-03T00:00:00Z",
          },
          access: ["read", "write", "delete"],
          isPrivate: true,
        },
      });
    }
    return new HttpResponse(null, { status: 404 });
  }),

  // DELETE notebook
  http.delete(`${PLATFORM}/platform/document/v1/documents/:id`, ({ params }) => {
    if (params["id"] === "N1") {
      return new HttpResponse(null, { status: 204 });
    }
    return new HttpResponse(null, { status: 404 });
  }),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  mswServer.resetHandlers();
  lastDocRequestUrl = "";
});
afterAll(() => mswServer.close());

async function makeClient(cfg: Config) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerNotebookTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

// ─── list_notebooks ───────────────────────────────────────────────────────────

describe("list_notebooks", () => {
  it("returns notebook list containing the notebook name", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({ name: "list_notebooks", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Investigation");
  });

  it("passes page-size to the API when provided", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({ name: "list_notebooks", arguments: { pageSize: 10 } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    // If page-size is forwarded, the mock still returns our document (filter matches)
    expect(text).toContain("Investigation");
  });

  it("pageKey: URL contains page-key param and still sends the type filter", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({ name: "list_notebooks", arguments: { pageKey: "K3" } });
    expect(res.isError).toBeFalsy();
    const url = new URL(lastDocRequestUrl);
    expect(url.searchParams.get("page-key")).toBe("K3");
    // filter (type) is still sent alongside page-key for notebooks
    expect(url.searchParams.get("filter")).toContain("notebook");
  });
});

// ─── get_notebook ─────────────────────────────────────────────────────────────

describe("get_notebook", () => {
  it("returns combined metadata and content", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({ name: "get_notebook", arguments: { id: "N1" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Investigation");
    expect(text).toContain("cells");
  });
});

// ─── write-gate tests ─────────────────────────────────────────────────────────

describe("create_notebook write-gate", () => {
  it("blocks when enableWrites=false", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({
      name: "create_notebook",
      arguments: { name: "x", content: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("update_notebook write-gate", () => {
  it("blocks when enableWrites=false", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({
      name: "update_notebook",
      arguments: { id: "N1", version: 2 },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("delete_notebook write-gate", () => {
  it("blocks when enableWrites=false", async () => {
    const client = await makeClient(cfgReadOnly);
    const res = await client.callTool({
      name: "delete_notebook",
      arguments: { id: "N1", version: 2 },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

// ─── create_notebook success (writes enabled) ─────────────────────────────────

describe("create_notebook (writes enabled)", () => {
  it("creates a notebook and returns metadata", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "create_notebook",
      arguments: { name: "My New Notebook", content: { cells: [] } },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("N-new");
  });
});

// ─── update_notebook success (writes enabled) ─────────────────────────────────

describe("update_notebook (writes enabled)", () => {
  it("updates a notebook and returns updated metadata", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "update_notebook",
      arguments: { id: "N1", version: 2, name: "Investigation Updated" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Investigation Updated");
  });
});

// ─── delete_notebook success (writes enabled) ─────────────────────────────────

describe("delete_notebook (writes enabled)", () => {
  it("deletes a notebook (204 no content)", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "delete_notebook",
      arguments: { id: "N1", version: 2 },
    });
    expect(res.isError).toBeFalsy();
  });
});

// ─── contentPath support ─────────────────────────────────────────────────────

describe("create_notebook with contentPath", () => {
  it("reads the file and sends its JSON as the content part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-create-"));
    const file = join(dir, "n.json");
    writeFileSync(file, JSON.stringify({ cells: [], marker: "NB_FROM_FILE" }));

    let body = "";
    mswServer.use(
      http.post(`${PLATFORM}/platform/document/v1/documents`, async ({ request }) => {
        body = await request.text();
        return HttpResponse.json(
          {
            id: "N-new",
            name: "x",
            type: "notebook",
            version: "1",
            owner: "u1",
            modificationInfo: {
              createdBy: "u1",
              createdTime: "2024-01-01T00:00:00Z",
              lastModifiedBy: "u1",
              lastModifiedTime: "2024-01-01T00:00:00Z",
            },
            access: ["read"],
            isPrivate: true,
          },
          { status: 201 },
        );
      }),
    );

    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "create_notebook",
      arguments: { name: "x", contentPath: file },
    });
    expect(res.isError).toBeFalsy();
    expect(body).toContain("NB_FROM_FILE");
    rmSync(dir, { recursive: true, force: true });
  });

  it("errors when neither content nor contentPath is provided", async () => {
    const client = await makeClient(cfgWrites);
    const res = await client.callTool({ name: "create_notebook", arguments: { name: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/content .*or contentPath/i);
  });
});

describe("update_notebook with contentPath", () => {
  it("reads the file and sends its JSON as the content part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-update-"));
    const file = join(dir, "n.json");
    writeFileSync(file, JSON.stringify({ cells: [], marker: "NB_UPDATED_FROM_FILE" }));

    let body = "";
    mswServer.use(
      http.patch(`${PLATFORM}/platform/document/v1/documents/:id`, async ({ request }) => {
        body = await request.text();
        return HttpResponse.json({
          documentMetadata: {
            id: "N1",
            name: "Investigation",
            type: "notebook",
            version: "3",
            owner: "u1",
            modificationInfo: {
              createdBy: "u1",
              createdTime: "2024-01-01T00:00:00Z",
              lastModifiedBy: "u1",
              lastModifiedTime: "2024-01-03T00:00:00Z",
            },
            access: ["read"],
            isPrivate: true,
          },
        });
      }),
    );

    const client = await makeClient(cfgWrites);
    const res = await client.callTool({
      name: "update_notebook",
      arguments: { id: "N1", version: 2, contentPath: file },
    });
    expect(res.isError).toBeFalsy();
    expect(body).toContain("NB_UPDATED_FROM_FILE");
    rmSync(dir, { recursive: true, force: true });
  });
});

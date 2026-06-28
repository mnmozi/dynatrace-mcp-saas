import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSettingsTools } from "../../src/tools/settings.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://p",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

const cfgWritesEnabled: Config = { ...cfg, enableWrites: true };

// Capture the last request URL for assertion in pagination tests
let lastRequestUrl = "";

const server = setupServer(
  http.get("https://classic.example.com/api/v2/settings/schemas", ({ request }) => {
    lastRequestUrl = request.url;
    return HttpResponse.json({ items: [{ schemaId: "builtin:tags", displayName: "Tags" }], totalCount: 1 });
  }),
  http.get("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
    lastRequestUrl = request.url;
    return HttpResponse.json({ items: [{ objectId: "obj-1", schemaId: "builtin:tags", scope: "environment", value: {} }], totalCount: 1, nextPageKey: "NEXT1" });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => { server.resetHandlers(); lastRequestUrl = ""; });
afterAll(() => server.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerSettingsTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_settings_schemas", () => {
  it("returns schema list containing builtin:tags", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_settings_schemas", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("builtin:tags");
  });
});

describe("list_settings_objects pagination", () => {
  it("first page: sends schemaIds and fields params", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "list_settings_objects",
      arguments: { schemaIds: "builtin:tags" },
    });
    expect(res.isError).toBeFalsy();
    const url = new URL(lastRequestUrl);
    expect(url.searchParams.get("schemaIds")).toBe("builtin:tags");
    expect(url.searchParams.get("fields")).toBeTruthy();
  });

  it("nextPageKey: URL contains only nextPageKey and NOT schemaIds/fields/pageSize", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "list_settings_objects",
      arguments: { nextPageKey: "ABC123", schemaIds: "builtin:tags" },
    });
    expect(res.isError).toBeFalsy();
    const url = new URL(lastRequestUrl);
    expect(url.searchParams.get("nextPageKey")).toBe("ABC123");
    expect(url.searchParams.has("schemaIds")).toBe(false);
    expect(url.searchParams.has("fields")).toBe(false);
    expect(url.searchParams.has("pageSize")).toBe(false);
  });
});

// ─────────────────────────────────────────────
// create_settings_object — auto-validate guard
// ─────────────────────────────────────────────

describe("create_settings_object — dryRun validates, never persists", () => {
  it("returns valid:true dryRun:true and does NOT call the bare persist POST", async () => {
    // Only register the validateOnly handler; a bare POST (without validateOnly) would trigger
    // onUnhandledRequest:"error" and fail the test automatically.
    server.use(
      http.post("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("validateOnly") === "true") {
          return HttpResponse.json({}, { status: 200 });
        }
        // Bare persist POST — should never happen in dryRun
        return new HttpResponse("unexpected persist call", { status: 500 });
      }),
    );

    const client = await makeClient(cfgWritesEnabled);
    const res = await client.callTool({
      name: "create_settings_object",
      arguments: { schemaId: "builtin:tags", scope: "environment", value: { key: "v" }, dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.valid).toBe(true);
    expect(body.dryRun).toBe(true);
  });
});

describe("create_settings_object — invalid value returns violations, no persist", () => {
  it("returns valid:false with violations and does NOT persist", async () => {
    server.use(
      http.post("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("validateOnly") === "true") {
          return HttpResponse.json(
            { error: { code: 400, constraintViolations: [{ path: "x", message: "bad" }] } },
            { status: 400 },
          );
        }
        // Should never be reached
        return new HttpResponse("unexpected persist call", { status: 500 });
      }),
    );

    const client = await makeClient(cfgWritesEnabled);
    const res = await client.callTool({
      name: "create_settings_object",
      arguments: { schemaId: "builtin:tags", scope: "environment", value: { bad: true } },
    });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.valid).toBe(false);
    expect(body.violations).toEqual([{ path: "x", message: "bad" }]);
  });
});

describe("create_settings_object — valid + writes enabled → validate THEN persist", () => {
  it("calls validateOnly then the bare persist POST and returns created result", async () => {
    let validateOnlyCalled = false;
    let persistCalled = false;

    server.use(
      http.post("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("validateOnly") === "true") {
          validateOnlyCalled = true;
          return HttpResponse.json({}, { status: 200 });
        }
        persistCalled = true;
        return HttpResponse.json([{ objectId: "new-obj-1", code: 200 }], { status: 200 });
      }),
    );

    const client = await makeClient(cfgWritesEnabled);
    const res = await client.callTool({
      name: "create_settings_object",
      arguments: { schemaId: "builtin:tags", scope: "environment", value: { key: "v" } },
    });

    expect(res.isError).toBeFalsy();
    expect(validateOnlyCalled).toBe(true);
    expect(persistCalled).toBe(true);
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body).toEqual([{ objectId: "new-obj-1", code: 200 }]);
  });
});

describe("create_settings_object — valid + writes DISABLED, dryRun false", () => {
  it("validate passes but requireWrites blocks → isError with DT_ENABLE_WRITES message", async () => {
    server.use(
      http.post("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("validateOnly") === "true") {
          return HttpResponse.json({}, { status: 200 });
        }
        return new HttpResponse("unexpected persist call", { status: 500 });
      }),
    );

    // Writes disabled (default cfg)
    const client = await makeClient(cfg);
    const res = await client.callTool({
      name: "create_settings_object",
      arguments: { schemaId: "builtin:tags", scope: "environment", value: { key: "v" } },
    });

    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

// ─────────────────────────────────────────────
// update_settings_object — dryRun
// ─────────────────────────────────────────────

describe("update_settings_object — dryRun validates, never PUTs", () => {
  it("GETs the object, runs validateOnly, returns valid:true dryRun:true, no PUT", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/settings/objects/O1", () => {
        return HttpResponse.json({ objectId: "O1", schemaId: "builtin:tags", scope: "environment", value: {} });
      }),
      http.post("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("validateOnly") === "true") {
          return HttpResponse.json({}, { status: 200 });
        }
        return new HttpResponse("unexpected persist call", { status: 500 });
      }),
      // No PUT handler registered — a PUT would trigger onUnhandledRequest:"error"
    );

    const client = await makeClient(cfgWritesEnabled);
    const res = await client.callTool({
      name: "update_settings_object",
      arguments: { objectId: "O1", value: { updated: true }, dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.valid).toBe(true);
    expect(body.dryRun).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Existing write-gate test (kept, adapted for auto-validate)
// ─────────────────────────────────────────────

describe("create_settings_object write-gate (legacy)", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled (validateOnly still runs first)", async () => {
    server.use(
      http.post("https://classic.example.com/api/v2/settings/objects", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("validateOnly") === "true") {
          return HttpResponse.json({}, { status: 200 });
        }
        return new HttpResponse("unexpected persist call", { status: 500 });
      }),
    );

    const client = await makeClient(cfg);
    const res = await client.callTool({
      name: "create_settings_object",
      arguments: { schemaId: "builtin:tags", scope: "environment", value: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

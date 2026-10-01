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
    return HttpResponse.json({
      items: [{ objectId: "obj-1", schemaId: "builtin:tags", scope: "environment", value: {} }],
      totalCount: 1,
      nextPageKey: "NEXT1",
    });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  lastRequestUrl = "";
});
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

describe("update_settings_object — validates the update via validateOnly PUT", () => {
  // No POST handler registered — a create-validation POST to the collection would trigger
  // onUnhandledRequest:"error" and fail the test.
  function recordPuts(validateResponse: () => Response) {
    const puts: Array<{ validateOnly: boolean; body: unknown }> = [];
    server.use(
      http.put("https://classic.example.com/api/v2/settings/objects/O1", async ({ request }) => {
        const validateOnly = new URL(request.url).searchParams.get("validateOnly") === "true";
        puts.push({ validateOnly, body: await request.json() });
        return validateOnly ? validateResponse() : HttpResponse.json({ code: 200, objectId: "O1" });
      }),
    );
    return puts;
  }

  it("dryRun: issues only the validateOnly PUT to the object path and returns valid:true dryRun:true", async () => {
    const puts = recordPuts(() => HttpResponse.json({}, { status: 200 }));

    const client = await makeClient(cfgWritesEnabled);
    const res = await client.callTool({
      name: "update_settings_object",
      arguments: { objectId: "O1", value: { updated: true }, dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toEqual({ valid: true, dryRun: true });
    expect(puts).toEqual([{ validateOnly: true, body: { value: { updated: true } } }]);
  });

  it("400 with constraintViolations: returns them without doing the real PUT", async () => {
    const puts = recordPuts(() =>
      HttpResponse.json(
        { error: { code: 400, message: "Validation failed", constraintViolations: [{ path: "x", message: "bad" }] } },
        { status: 400 },
      ),
    );

    const client = await makeClient(cfgWritesEnabled);
    const res = await client.callTool({
      name: "update_settings_object",
      arguments: { objectId: "O1", value: { bad: true } },
    });

    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.valid).toBe(false);
    expect(body.violations).toEqual([{ path: "x", message: "bad" }]);
    expect(puts.map((p) => p.validateOnly)).toEqual([true]);
  });

  it("valid + writes enabled: validateOnly PUT then the real PUT", async () => {
    const puts = recordPuts(() => HttpResponse.json({}, { status: 200 }));

    const client = await makeClient(cfgWritesEnabled);
    const res = await client.callTool({
      name: "update_settings_object",
      arguments: { objectId: "O1", value: { updated: true } },
    });

    expect(res.isError).toBeFalsy();
    expect(puts.map((p) => p.validateOnly)).toEqual([true, false]);
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

describe("validate_settings_object — 400 body shapes", () => {
  function rejectValidationWith(body: unknown) {
    server.use(
      http.post("https://classic.example.com/api/v2/settings/objects", () => HttpResponse.json(body, { status: 400 })),
    );
  }

  async function validate() {
    const client = await makeClient();
    const res = await client.callTool({
      name: "validate_settings_object",
      arguments: { schemaId: "builtin:tags", scope: "environment", value: { bad: true } },
    });
    expect(res.isError).toBeFalsy();
    return JSON.parse((res.content as Array<{ text: string }>)[0].text);
  }

  it("returns violations and reason from a per-object array body", async () => {
    rejectValidationWith([
      {
        code: 400,
        error: {
          code: 400,
          message: "Validation failed",
          constraintViolations: [{ path: "azure/clientSecret", message: "must not be empty" }],
        },
      },
    ]);

    expect(await validate()).toEqual({
      valid: false,
      violations: [{ path: "azure/clientSecret", message: "must not be empty" }],
      reason: "Validation failed; azure/clientSecret: must not be empty",
    });
  });

  it("returns the reason when the 400 carries a message but no violations", async () => {
    rejectValidationWith({ error: { code: 400, message: "Scope is not supported by this schema" } });

    expect(await validate()).toEqual({
      valid: false,
      violations: [],
      reason: "Scope is not supported by this schema",
    });
  });
});

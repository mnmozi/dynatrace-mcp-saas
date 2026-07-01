import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerEntitiesTools } from "../../src/tools/entities.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

let lastUrl = "";

/** Standard DQL success response */
function dqlSuccess(records: Array<Record<string, unknown>>) {
  return HttpResponse.json({
    state: "SUCCEEDED",
    result: { records },
  });
}

// The msw server has NO classic handlers by default.
// onUnhandledRequest: "error" means if the tool accidentally hits classic, the test fails.
// That's the proof the inversion worked — default path must NOT call classic.
const server = setupServer(
  // Only the DQL endpoint is registered by default.
  http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
    dqlSuccess([{ id: "HOST-1", "entity.name": "web01" }]),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  lastUrl = "";
  // Re-register the default DQL handler after resetHandlers
  server.use(
    http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
      dqlSuccess([{ id: "HOST-1", "entity.name": "web01" }]),
    ),
  );
});
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerEntitiesTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

// ---------------------------------------------------------------------------
// Default path (Grail DQL) — NO classic endpoint mocked; any call to classic = test fail
// ---------------------------------------------------------------------------

describe("list_hosts (default = Grail DQL)", () => {
  it("queries Grail DQL directly — does NOT call classic Entities API", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("grail-dql");
    expect(text).toContain("fetch dt.entity.host");
  });

  it("returns DQL records including entity data", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        dqlSuccess([{ id: "HOST-1", "entity.name": "web01" }]),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("web01");
  });

  it("includes a note when tag is supplied (filters require useClassic)", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: { tag: "env:prod" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("grail-dql");
    expect(text).toContain("useClassic");
  });

  it("includes a note when managementZone is supplied", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: { managementZone: "my-zone" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("grail-dql");
    expect(text).toContain("useClassic");
  });
});

describe("find_entities (default = Grail DQL)", () => {
  it("parses type() and entityName.contains() and queries Grail DQL directly", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        dqlSuccess([{ id: "SERVICE-1", "entity.name": "checkout" }]),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "find_entities",
      arguments: { entitySelector: 'type(SERVICE),entityName.contains("checkout")' },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("grail-dql");
    expect(text).toContain("fetch dt.entity.service");
    expect(text).toContain("contains(entity.name,");
    expect(text).toContain("checkout");
  });

  it("returns structured unavailable when selector has no type() clause (mentions execute_dql AND useClassic)", async () => {
    // No DQL call expected here — we return early with the guidance message
    server.use(http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () => dqlSuccess([])));
    const client = await makeClient();
    const res = await client.callTool({
      name: "find_entities",
      arguments: { entitySelector: 'entityName.contains("something")' },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("unavailable");
    expect(text).toContain("execute_dql");
    expect(text).toContain("useClassic");
  });
});

describe("get_entity (default = Grail DQL)", () => {
  it("derives entity table from id prefix and queries Grail DQL directly", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        dqlSuccess([{ id: "PROCESS_GROUP-12", "entity.name": "my-process" }]),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "get_entity", arguments: { entityId: "PROCESS_GROUP-12" } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("grail-dql");
    expect(text).toContain("fetch dt.entity.process_group");
    expect(text).toContain("PROCESS_GROUP-12");
  });
});

describe("list_entity_types (default = Grail guidance message)", () => {
  it("returns Grail entity table guidance WITHOUT calling classic — mentions dt.entity.host", async () => {
    // No DQL mock needed: this tool returns a static guidance message
    // If the tool accidentally calls classic, msw will throw (onUnhandledRequest: "error")
    const client = await makeClient();
    const res = await client.callTool({ name: "list_entity_types", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("dt.entity.host");
    expect(text).toContain("useClassic");
  });
});

// ---------------------------------------------------------------------------
// escapeQuotes regression — classic path (useClassic: true)
// ---------------------------------------------------------------------------

describe("list_hosts useClassic — escapeQuotes regression", () => {
  it("escapes double-quotes in the tag filter of the entitySelector (classic path)", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities", ({ request }) => {
        lastUrl = request.url;
        return HttpResponse.json({ entities: [{ entityId: "HOST-1", displayName: "web01" }], totalCount: 1 });
      }),
    );
    const client = await makeClient();
    await client.callTool({ name: "list_hosts", arguments: { tag: 'env"prod', useClassic: true } });
    const selector = decodeURIComponent(new URL(lastUrl).searchParams.get("entitySelector")!);
    expect(selector).toContain('tag("env\\"prod")');
  });

  it("escapes double-quotes in the managementZone filter (classic path)", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities", ({ request }) => {
        lastUrl = request.url;
        return HttpResponse.json({ entities: [{ entityId: "HOST-1", displayName: "web01" }], totalCount: 1 });
      }),
    );
    const client = await makeClient();
    await client.callTool({ name: "list_hosts", arguments: { managementZone: 'zone"A', useClassic: true } });
    const selector = decodeURIComponent(new URL(lastUrl).searchParams.get("entitySelector")!);
    expect(selector).toContain('mzName("zone\\"A")');
  });
});

// ---------------------------------------------------------------------------
// useClassic: true — calls the classic API directly, no DQL
// ---------------------------------------------------------------------------

describe("list_hosts useClassic: true", () => {
  it("calls classic Entities API and returns its payload (no DQL)", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities", () =>
        HttpResponse.json({ entities: [{ entityId: "HOST-1", displayName: "web01" }], totalCount: 1 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: { useClassic: true } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("web01");
    // Must NOT say "grail-dql"
    expect(text).not.toContain("grail-dql");
  });
});

describe("list_entity_types useClassic: true", () => {
  it("calls classic entityTypes API and returns its payload", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entityTypes", () =>
        HttpResponse.json({ types: [{ type: "HOST", displayName: "Host" }], totalCount: 1 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_entity_types", arguments: { useClassic: true } });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("HOST");
    expect(text).not.toContain("grail-dql");
  });
});

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
  platformUrl: "https://plat.example.com", classicUrl: "https://classic.example.com",
  platformToken: "P", apiToken: "A", enableWrites: false, timeoutMs: 5000,
};

let lastUrl = "";

/** Standard 404 "endpoint unavailable" response from Gen3 tenants (factory — body stream must not be reused) */
function gen3NotFound() {
  return HttpResponse.json(
    { error: { code: 404, message: "REST endpoint is not available for this environment." } },
    { status: 404 },
  );
}

/** Standard DQL success response */
function dqlSuccess(records: Array<Record<string, unknown>>) {
  return HttpResponse.json({
    state: "SUCCEEDED",
    result: { records },
  });
}

const server = setupServer(
  http.get("https://classic.example.com/api/v2/entities", ({ request }) => {
    lastUrl = request.url;
    return HttpResponse.json({ entities: [{ entityId: "HOST-1", displayName: "web01" }], totalCount: 1 });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  lastUrl = "";
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
// Classic success tests (preserved)
// ---------------------------------------------------------------------------

describe("list_entity_types", () => {
  it("returns entity types", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entityTypes", () =>
        HttpResponse.json({ types: [{ type: "HOST" }], totalCount: 1 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_entity_types", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("HOST");
  });
});

describe("list_hosts", () => {
  it("returns host entities", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("web01");
  });

  it("escapes double-quotes in the tag filter of the entitySelector", async () => {
    const client = await makeClient();
    await client.callTool({ name: "list_hosts", arguments: { tag: 'env"prod' } });
    const selector = decodeURIComponent(new URL(lastUrl).searchParams.get("entitySelector")!);
    expect(selector).toContain('tag("env\\"prod")');
  });

  it("escapes double-quotes in the managementZone filter of the entitySelector", async () => {
    const client = await makeClient();
    await client.callTool({ name: "list_hosts", arguments: { managementZone: 'zone"A' } });
    const selector = decodeURIComponent(new URL(lastUrl).searchParams.get("entitySelector")!);
    expect(selector).toContain('mzName("zone\\"A")');
  });
});

// ---------------------------------------------------------------------------
// Gen3 / Grail DQL fallback tests
// ---------------------------------------------------------------------------

describe("list_hosts fallback (Gen3)", () => {
  it("falls back to Grail DQL when classic Entities API returns 404", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities", () => gen3NotFound()),
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        dqlSuccess([{ id: "HOST-1", "entity.name": "web01" }]),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("grail-dql");
    expect(text).toContain("web01");
    expect(text).toContain("fetch dt.entity.host");
  });

  it("includes a note when tag/managementZone filters cannot be applied in DQL fallback", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities", () => gen3NotFound()),
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        dqlSuccess([{ id: "HOST-1", "entity.name": "web01" }]),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_hosts", arguments: { tag: "env:prod" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("grail-dql");
    expect(text).toContain("tag/managementZone filters are not applied");
  });
});

describe("find_entities fallback (Gen3)", () => {
  it("parses type() and entityName.contains() from selector and falls back to Grail DQL", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities", () => gen3NotFound()),
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
  });

  it("returns unavailable response when selector has no type() clause", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities", () => gen3NotFound()),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "find_entities",
      arguments: { entitySelector: 'entityName.contains("something")' },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("unavailable");
    expect(text).toContain("execute_dql");
  });
});

describe("get_entity fallback (Gen3)", () => {
  it("derives entity table from id prefix and falls back to Grail DQL", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entities/PROCESS_GROUP-12", () => gen3NotFound()),
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

describe("list_entity_types fallback (Gen3)", () => {
  it("returns structured unavailable message when classic entityTypes API returns 404", async () => {
    server.use(
      http.get("https://classic.example.com/api/v2/entityTypes", () => gen3NotFound()),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "list_entity_types", arguments: {} });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("unavailable");
    expect(text).toContain("dt.entity.host");
  });
});

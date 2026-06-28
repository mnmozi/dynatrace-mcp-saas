import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDqlTools } from "../../src/tools/dql.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com", classicUrl: "https://c",
  platformToken: "P", apiToken: "A", enableWrites: false, timeoutMs: 5000,
};

const server = setupServer(
  http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
    HttpResponse.json({ state: "SUCCEEDED", result: { records: [{ n: 1 }] } }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerDqlTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

// Real 400 envelope captured from the tenant for a field-not-found DQL error.
const FIELD_NOT_FOUND_BODY = {
  error: {
    message: "FIELD_DOES_NOT_EXIST",
    code: 400,
    details: {
      exceptionType: "DQL-RESULT_TYPE",
      errorType: "FIELD_DOES_NOT_EXIST",
      errorMessage: "The field content doesn't exist.",
      syntaxErrorPosition: { start: { column: 56, index: 55, line: 1 }, end: { column: 62, index: 61, line: 1 } },
    },
  },
};

describe("execute_dql tool", () => {
  it("returns records as JSON text", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "execute_dql", arguments: { query: "fetch logs | limit 1" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"n": 1');
  });

  it("surfaces Dynatrace's validation detail on a 400 instead of 'request failed'", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json(FIELD_NOT_FOUND_BODY, { status: 400 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "execute_dql",
      arguments: { query: 'fetch logs | summarize count(), by:{loglevel} | filter content == "x"' },
    });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("The field content doesn't exist.");
    expect(parsed.errorType).toBe("FIELD_DOES_NOT_EXIST");
    expect(parsed.position).toEqual({ line: 1, column: 56 });
  });
});

describe("verify_dql tool", () => {
  it("returns ok:true for a valid query", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "verify_dql", arguments: { query: "fetch logs" } });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("returns ok:false with field, type, and position on a validation error", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json(FIELD_NOT_FOUND_BODY, { status: 400 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "verify_dql",
      arguments: { query: 'fetch logs | summarize count(), by:{loglevel} | filter content == "x"' },
    });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("The field content doesn't exist.");
    expect(parsed.errorType).toBe("FIELD_DOES_NOT_EXIST");
    expect(parsed.exceptionType).toBe("DQL-RESULT_TYPE");
    expect(parsed.position).toEqual({ line: 1, column: 56 });
  });
});

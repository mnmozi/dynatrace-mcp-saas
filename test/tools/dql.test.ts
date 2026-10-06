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
  platformUrl: "https://plat.example.com",
  classicUrl: "https://c",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
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

// Real 403 shape from a platform API when the token lacks a scope.
const MISSING_SCOPE_BODY = {
  error: {
    code: 403,
    message: "Authorization token is missing required scope: storage:logs:read.",
    details: { missingScopes: ["storage:logs:read"] },
  },
};

// Documented 403 example of the storage query API: a permission problem that still carries Grail error fields.
const TABLE_NOT_ALLOWED_BODY = {
  error: {
    code: 403,
    message: "QUERY_PLAN_BUILD_FAILURE",
    details: {
      errorMessage: "Failed to build query plan: Accessing table events is not allowed.",
      errorType: "QUERY_PLAN_BUILD_FAILURE",
      exceptionType: "DQL-EXEC-MAPPING",
      queryString: "fetch events",
    },
  },
};

describe("execute_dql tool", () => {
  it("surfaces Grail notifications as warnings, plus scannedBytes", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json({
          state: "SUCCEEDED",
          result: {
            records: [{ n: 1 }],
            metadata: {
              grail: {
                scannedBytes: 1234,
                notifications: [
                  {
                    severity: "WARNING",
                    notificationType: "RELATIONSHIP_RESULT_SIZE_LIMIT",
                    message:
                      "The number of entity IDs in the relationship fields has been limited. Please try filtering or narrowing your timeframe.",
                  },
                ],
              },
            },
          },
        }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({
      name: "execute_dql",
      arguments: { query: "fetch dt.entity.kubernetes_cluster" },
    });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.scannedBytes).toBe(1234);
    expect(body.warnings).toEqual([
      {
        severity: "WARNING",
        type: "RELATIONSHIP_RESULT_SIZE_LIMIT",
        message:
          "The number of entity IDs in the relationship fields has been limited. Please try filtering or narrowing your timeframe.",
      },
    ]);
  });

  it("omits warnings when Grail sends none", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "execute_dql", arguments: { query: "fetch logs | limit 1" } });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(body.warnings).toBeUndefined();
  });

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
    expect(res.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("The field content doesn't exist.");
    expect(parsed.errorType).toBe("FIELD_DOES_NOT_EXIST");
    expect(parsed.position).toEqual({ line: 1, column: 56 });
  });

  it("reports a missing scope with the standard 403 message, not as a query error", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json(MISSING_SCOPE_BODY, { status: 403 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "execute_dql", arguments: { query: "fetch logs" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toBe(
      "403 Forbidden: the platform token is missing a required scope or permission for this endpoint. " +
        "(platform /platform/storage/query/v1/query:execute) — Authorization token is missing required scope: storage:logs:read.",
    );
  });

  it("throws a 403 that carries Grail error fields instead of calling it a query error (documented shape)", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json(TABLE_NOT_ALLOWED_BODY, { status: 403 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "execute_dql", arguments: { query: "fetch events" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toBe(
      "403 Forbidden: the platform token is missing a required scope or permission for this endpoint. " +
        "(platform /platform/storage/query/v1/query:execute) — " +
        "Failed to build query plan: Accessing table events is not allowed. [QUERY_PLAN_BUILD_FAILURE]",
    );
  });

  it("throws a 400 that is about the request, not the query text (documented shape)", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json(
          {
            error: {
              code: 400,
              message: "Constraint Violations",
              details: { constraintViolations: [{ message: "must not be null", parameterDescriptor: "query" }] },
            },
          },
          { status: 400 },
        ),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "execute_dql", arguments: { query: "" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toBe(
      "400: request failed. (platform /platform/storage/query/v1/query:execute) — Constraint Violations; query: must not be null",
    );
  });

  it("reports a query that FAILED while polling as an error carrying Grail's reason", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json({ state: "RUNNING", requestToken: "RT" }, { status: 202 }),
      ),
      http.get("https://plat.example.com/platform/storage/query/v1/query:poll", () =>
        HttpResponse.json({
          state: "FAILED",
          error: {
            code: 400,
            message: "QUERY_TIMEOUT",
            details: { errorType: "QUERY_TIMEOUT", errorMessage: "Query exceeded the time limit." },
          },
        }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "execute_dql", arguments: { query: "fetch logs" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toBe(
      "DQL query FAILED — Query exceeded the time limit. [QUERY_TIMEOUT]",
    );
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
    // A rejected query is verify_dql's answer, so it is not flagged as a tool error.
    expect(res.isError).toBeFalsy();
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("The field content doesn't exist.");
    expect(parsed.errorType).toBe("FIELD_DOES_NOT_EXIST");
    expect(parsed.exceptionType).toBe("DQL-RESULT_TYPE");
    expect(parsed.position).toEqual({ line: 1, column: 56 });
  });

  it("fails as a tool error when the query could not be checked at all (401)", async () => {
    server.use(
      http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
        HttpResponse.json({ error: { code: 401, message: "Unauthorized" } }, { status: 401 }),
      ),
    );
    const client = await makeClient();
    const res = await client.callTool({ name: "verify_dql", arguments: { query: "fetch logs" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toContain("Check DT_PLATFORM_TOKEN");
  });
});

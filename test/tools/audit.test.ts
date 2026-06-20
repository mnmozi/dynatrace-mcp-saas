import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAuditTools } from "../../src/tools/audit.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://p", classicUrl: "https://classic.example.com",
  platformToken: "P", apiToken: "A", enableWrites: false, timeoutMs: 5000,
};

const server = setupServer(
  http.get("https://classic.example.com/api/v2/auditlogs", () =>
    HttpResponse.json({
      auditLogs: [{ logId: "a1", user: "x@example.com", eventType: "UPDATE", category: "CONFIG", environmentId: "env-1", success: true, timestamp: 1000, userType: "USER_NAME" }],
      totalCount: 1,
    }),
  ),
  http.get("https://classic.example.com/api/v2/auditlogs/a1", () =>
    HttpResponse.json({ logId: "a1", user: "x@example.com", eventType: "UPDATE", category: "CONFIG", environmentId: "env-1", success: true, timestamp: 1000, userType: "USER_NAME" }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerAuditTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_audit_logs", () => {
  it("returns audit log list containing logId a1", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_audit_logs", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("a1");
  });
});

describe("get_audit_log", () => {
  it("returns a single audit log entry by id", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_audit_log", arguments: { id: "a1" } });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("x@example.com");
  });
});

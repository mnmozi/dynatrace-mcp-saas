import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerNotificationTools } from "../../src/tools/notifications.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(`${PLATFORM}/platform/notification/v2/event-notifications`, () =>
    HttpResponse.json({
      count: 1,
      results: [{ id: "n1", title: "My Event Notification" }],
    }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerNotificationTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_event_notifications", () => {
  it("returns event notification list containing the notification id", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_event_notifications", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("n1");
  });
});

describe("create_event_notification write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_event_notification",
      arguments: { notification: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

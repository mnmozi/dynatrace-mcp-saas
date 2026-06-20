import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerEmailTools } from "../../src/tools/email.js";
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

const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerEmailTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("send_email write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "send_email",
      arguments: { email: { subject: "hi" } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("send_email — success", () => {
  it("POSTs to /platform/email/v1/emails and returns requestId; extra fields are preserved", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${PLATFORM}/platform/email/v1/emails`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(
          {
            requestId: "r1",
            message: "Email request accepted for at least one recipient",
            rejectedDestinations: { bouncingDestinations: [], complainingDestinations: [] },
            unresolvedUserDestinations: [],
            unresolvedGroupDestinations: [],
            invalidDestinations: [],
          },
          { status: 202 },
        );
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);

    const res = await client.callTool({
      name: "send_email",
      arguments: {
        email: {
          toRecipients: {
            emailAddresses: ["alice@example.com"],
            ssoUserIds: [],
            ssoGroupIds: [],
          },
          subject: "VPN alert: server degraded",
          body: {
            contentType: "text/plain",
            body: "Server us-east-1 has elevated latency. Please investigate.",
          },
          notificationSettingsUrl: "https://plat.example.com/notifications",
          // extra field — must be forwarded as-is
          customTag: "ops-team",
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("r1");

    // Verify the posted body was forwarded intact, including extra field
    const posted = capturedBody as Record<string, unknown>;
    expect(posted.subject).toBe("VPN alert: server degraded");
    expect((posted.toRecipients as Record<string, unknown>).emailAddresses).toEqual(["alice@example.com"]);
    expect((posted.body as Record<string, unknown>).contentType).toBe("text/plain");
    expect(posted.customTag).toBe("ops-team");
  });
});

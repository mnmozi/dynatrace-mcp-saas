import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSyntheticTools } from "../../src/tools/synthetic.js";
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
  http.get(`${PLATFORM}/platform/synthetic/v1/monitors`, () =>
    HttpResponse.json({
      monitors: [{ entityId: "SYNTHETIC_TEST-M1", name: "Homepage" }],
    }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerSyntheticTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_monitors", () => {
  it("returns monitors list containing the monitor name", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_monitors", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Homepage");
  });
});

describe("create_monitor write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_monitor",
      arguments: { monitor: { name: "Homepage" } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("create_monitor — passthrough acceptance", () => {
  it("preserves all fields including steps, type, and extra fields in the POST body", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${PLATFORM}/platform/synthetic/v1/monitors`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ entityId: "SYNTHETIC_TEST-NEW" });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "create_monitor",
      arguments: {
        monitor: {
          name: "Homepage",
          type: "HTTP",
          enabled: true,
          frequencyMin: 5,
          locations: ["SYNTHETIC_LOCATION-D3A5BFD8676A4F19"],
          // polymorphic field — must be preserved by passthrough
          steps: [{ requestType: "HTTP", name: "Load homepage", url: "https://example.com" }],
          // extra field — must be preserved by passthrough
          customField: 1,
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as Record<string, unknown>;
    expect(posted.name).toBe("Homepage");
    expect(posted.type).toBe("HTTP");
    expect(posted.enabled).toBe(true);
    // steps must be preserved by .passthrough()
    const stepsArr = posted.steps as Array<Record<string, unknown>>;
    expect(Array.isArray(stepsArr)).toBe(true);
    expect(stepsArr[0].requestType).toBe("HTTP");
    // extra field must be preserved by .passthrough()
    expect(posted.customField).toBe(1);
  });
});

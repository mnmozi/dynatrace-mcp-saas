import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerConfigV1Tools } from "../../src/tools/config-v1.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const CLASSIC = "https://classic.example.com";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: CLASSIC,
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(`${CLASSIC}/api/config/v1/service/requestAttributes`, () =>
    HttpResponse.json({ values: [{ id: "RA-1", name: "My Attr" }] }),
  ),
  http.get(`${CLASSIC}/api/config/v1/service/customServices/java`, () =>
    HttpResponse.json({ values: [{ id: "CS-1", name: "Checkout" }] }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerConfigV1Tools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_request_attributes", () => {
  it("returns request attributes list containing the attribute name", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_request_attributes", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("My Attr");
  });
});

describe("list_custom_services", () => {
  it("returns custom services list for a given technology", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "list_custom_services",
      arguments: { technology: "java" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Checkout");
  });
});

describe("create_request_attribute write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_request_attribute",
      arguments: { requestAttribute: { name: "test-attr" } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("create_request_attribute — passthrough acceptance", () => {
  it("preserves all fields including dataSources[0].parameterName in the POST body", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${CLASSIC}/api/config/v1/service/requestAttributes`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "RA-NEW", name: "my-param" });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "create_request_attribute",
      arguments: {
        requestAttribute: {
          name: "my-param",
          enabled: false,
          dataType: "STRING",
          normalization: "ORIGINAL",
          aggregation: "FIRST",
          confidential: false,
          skipPersonalDataMasking: false,
          dataSources: [
            {
              enabled: true,
              source: "POST_PARAMETER",
              parameterName: "x",
              // extra field — must be preserved by passthrough
              extraCapture: "custom",
            },
          ],
          // extra top-level field — must be preserved by passthrough
          customMetadata: "preserved",
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as Record<string, unknown>;
    expect(posted.name).toBe("my-param");
    expect(posted.dataType).toBe("STRING");
    expect(posted.confidential).toBe(false);
    expect(posted.customMetadata).toBe("preserved");

    const sources = posted.dataSources as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources[0].source).toBe("POST_PARAMETER");
    // Critically: parameterName must be preserved by .passthrough()
    expect(sources[0].parameterName).toBe("x");
    expect(sources[0].extraCapture).toBe("custom");
  });
});

describe("create_request_naming — passthrough acceptance", () => {
  it("preserves namingPattern and conditions including comparisonInfo in the POST body", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${CLASSIC}/api/config/v1/service/requestNaming`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "RN-NEW" });
      }),
    );

    const writeCfg: Config = { ...cfg, enableWrites: true };
    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "create_request_naming",
      arguments: {
        requestNaming: {
          namingPattern: "{serviceMethod} [{serviceType}]",
          enabled: false,
          managementZones: [],
          conditions: [
            {
              attribute: "SERVICE_TYPE",
              comparisonInfo: {
                type: "SERVICE_TYPE",
                comparison: "EQUALS",
                value: "WEB_SERVICE",
                negate: false,
                // extra field in comparisonInfo — must be preserved
                extraFlag: true,
              },
            },
          ],
          // extra top-level field — must be preserved by passthrough
          customTag: "my-tag",
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const posted = capturedBody as Record<string, unknown>;
    expect(posted.namingPattern).toBe("{serviceMethod} [{serviceType}]");
    expect(posted.enabled).toBe(false);
    expect(posted.customTag).toBe("my-tag");

    const conditions = posted.conditions as Array<Record<string, unknown>>;
    expect(Array.isArray(conditions)).toBe(true);
    expect(conditions[0].attribute).toBe("SERVICE_TYPE");
    const ci = conditions[0].comparisonInfo as Record<string, unknown>;
    expect(ci.comparison).toBe("EQUALS");
    expect(ci.value).toBe("WEB_SERVICE");
    // extra field must be preserved by .passthrough()
    expect(ci.extraFlag).toBe(true);
  });
});

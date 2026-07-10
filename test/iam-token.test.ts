import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIamTools } from "../src/tools/iam.js";
import { registerRawTools } from "../src/tools/raw.js";
import { DynatraceClient } from "../src/http/client.js";
import { loadConfig } from "../src/config.js";
import type { Config } from "../src/types.js";

const PLATFORM = "https://plat.example.com";

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "MAINTOK",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config) {
  const mcp = new McpServer({ name: "t", version: "0" });
  const deps = { client: new DynatraceClient(config), config };
  registerIamTools(mcp, deps);
  registerRawTools(mcp, deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("DT_IAM_TOKEN routing", () => {
  it("IAM tools send the dedicated iam token when configured", async () => {
    let auth = "";
    mswServer.use(
      http.get(`${PLATFORM}/platform/iam/v1/organizational-levels/environment/env-1/users`, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ users: [] });
      }),
    );
    const client = await makeClient({ ...cfg, iamToken: "IAMTOK" });
    const res = await client.callTool({
      name: "list_iam_users",
      arguments: { levelType: "environment", levelId: "env-1" },
    });
    expect(res.isError).toBeFalsy();
    expect(auth).toBe("Bearer IAMTOK");
  });

  it("IAM tools fall back to the main platform token when DT_IAM_TOKEN is absent", async () => {
    let auth = "";
    mswServer.use(
      http.get(`${PLATFORM}/platform/iam/v1/organizational-levels/environment/env-1/users`, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ users: [] });
      }),
    );
    const client = await makeClient(cfg);
    const res = await client.callTool({
      name: "list_iam_users",
      arguments: { levelType: "environment", levelId: "env-1" },
    });
    expect(res.isError).toBeFalsy();
    expect(auth).toBe("Bearer MAINTOK");
  });

  it("raw_get host='iam' uses the iam token", async () => {
    let auth = "";
    mswServer.use(
      http.get(`${PLATFORM}/platform/iam/v1/whatever`, ({ request }) => {
        auth = request.headers.get("authorization") ?? "";
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = await makeClient({ ...cfg, iamToken: "IAMTOK" });
    const res = await client.callTool({
      name: "raw_get",
      arguments: { host: "iam", path: "/platform/iam/v1/whatever" },
    });
    expect(res.isError).toBeFalsy();
    expect(auth).toBe("Bearer IAMTOK");
  });
});

describe("loadConfig DT_IAM_TOKEN validation", () => {
  const baseEnv = {
    DT_PLATFORM_URL: PLATFORM,
    DT_PLATFORM_TOKEN: "PT",
  };

  it("accepts DT_IAM_TOKEN alongside the platform pair", () => {
    const c = loadConfig({ ...baseEnv, DT_IAM_TOKEN: "IAMTOK" });
    expect(c.iamToken).toBe("IAMTOK");
  });

  it("rejects DT_IAM_TOKEN without a platform host", () => {
    expect(() =>
      loadConfig({ DT_CLASSIC_URL: "https://c.example.com", DT_API_TOKEN: "AT", DT_IAM_TOKEN: "IAMTOK" }),
    ).toThrow(/DT_IAM_TOKEN/);
  });
});

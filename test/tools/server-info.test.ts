import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerServerInfoTools } from "../../src/tools/server-info.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://platform.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerServerInfoTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("get_server_info", () => {
  it("returns version matching package.json, writesEnabled false, and correct URLs", async () => {
    const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const expectedVersion = pkg.version as string;

    const client = await makeClient();
    const res = await client.callTool({ name: "get_server_info", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    const data = JSON.parse(text) as Record<string, unknown>;

    expect(data.version).toBe(expectedVersion);
    expect(data.writesEnabled).toBe(false);
    expect(data.platformUrl).toBe(cfg.platformUrl);
    expect(data.classicUrl).toBe(cfg.classicUrl);
    expect(data.name).toBe("dynatrace-saas-mcp");
  });

  it("does NOT expose token values in output", async () => {
    const secretCfg: Config = {
      platformUrl: "https://platform.example.com",
      classicUrl: "https://classic.example.com",
      platformToken: "SECRET_P",
      apiToken: "SECRET_A",
      enableWrites: false,
      timeoutMs: 5000,
    };
    const client = await makeClient(secretCfg);
    const res = await client.callTool({ name: "get_server_info", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;

    expect(text).not.toContain("SECRET_P");
    expect(text).not.toContain("SECRET_A");
  });

  it("reports gitCommit containing 'dev' when no build stamp exists (src/ context)", async () => {
    // In dev/test the tool runs from src/ where no build-info.json is present
    const client = await makeClient();
    const res = await client.callTool({ name: "get_server_info", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    const data = JSON.parse(text) as Record<string, unknown>;

    // getBuildInfo() falls back to "dev (no build stamp)" when build-info.json is absent
    expect(String(data.gitCommit)).toContain("dev");
  });
});

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../src/tools/registry.js";
import { DynatraceClient } from "../src/http/client.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  platformUrl: "https://p",
  classicUrl: "https://c",
  platformToken: "p",
  apiToken: "a",
  enableWrites: false,
  timeoutMs: 1000,
};

describe("registerAllTools", () => {
  it("registers tools without throwing", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const client = new DynatraceClient(cfg);
    expect(() => registerAllTools(server, { client, config: cfg })).not.toThrow();
  });
});

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/registry.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = { platformUrl: "https://p", classicUrl: "https://c", platformToken: "p", apiToken: "a", enableWrites: false, timeoutMs: 1000 };

describe("registry", () => {
  it("exposes the expected tools", async () => {
    const mcp = new McpServer({ name: "t", version: "0" });
    registerAllTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([mcp.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ["execute_dql", "list_metrics", "list_hosts", "list_problems",
      "search_logs", "search_spans", "get_trace", "list_settings_schemas",
      "create_settings_object", "list_dashboards", "create_dashboard", "list_notebooks",
      "list_slos", "create_slo", "list_monitors", "list_vulnerabilities"]) {
      expect(names).toContain(expected);
    }
  });
});

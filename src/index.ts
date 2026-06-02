import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { DynatraceClient } from "./http/client.js";
import { registerAllTools } from "./tools/registry.js";

async function main() {
  const config = loadConfig();
  const client = new DynatraceClient(config);
  const server = new McpServer({ name: "dynatrace-saas-mcp", version: "0.1.0" });
  registerAllTools(server, { client, config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `dynatrace-saas-mcp ready (writes ${config.enableWrites ? "ENABLED" : "disabled"})`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

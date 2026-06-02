import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DynatraceClient } from "../http/client.js";
import type { Config } from "../types.js";
import { registerDqlTools } from "./dql.js";
import { registerMetricsTools } from "./metrics.js";

export interface ToolDeps { client: DynatraceClient; config: Config }

// Tool registrations are added here by Tasks 8–19.
export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerDqlTools(server, deps);
  registerMetricsTools(server, deps);
}

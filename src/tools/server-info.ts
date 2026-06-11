import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { getVersion, getBuildInfo } from "../version.js";
import { jsonResult } from "../util/result.js";

export function registerServerInfoTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_server_info",
    {
      description:
        "Report this MCP server's build identity: version, git commit, build time, write-mode, and target Dynatrace hosts. Use to verify which build is running.",
      inputSchema: {},
    },
    async () => {
      const [version, build] = await Promise.all([getVersion(), getBuildInfo()]);
      return jsonResult({
        name: "dynatrace-saas-mcp",
        version,
        gitCommit: build.gitCommit,
        buildTime: build.buildTime,
        writesEnabled: deps.config.enableWrites,
        platformUrl: deps.config.platformUrl,
        classicUrl: deps.config.classicUrl,
      });
    },
  );
}

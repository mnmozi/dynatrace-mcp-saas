import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

const BASE = "/platform/vulnerabilities/v1";

export function registerVulnerabilitiesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_vulnerabilities",
    {
      description:
        "List security vulnerabilities (Dynatrace Platform Vulnerabilities v1). " +
        "Supports optional DQL-style filter expressions, sort, and time range.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Filter expression, e.g. 'davisAssessment.exploitStatus = \"AVAILABLE\" and risk.score > 8'."),
        sort: z.string().optional().describe('Sort expression, e.g. "-risk.score" for descending risk score.'),
        startTime: z
          .string()
          .optional()
          .describe('Start of timeframe. ISO-8601 timestamp or relative, e.g. "now-7d". Defaults to "now-30m".'),
        endTime: z.string().optional().describe('End of timeframe. Only "now" is supported. Defaults to "now".'),
      },
    },
    async ({ filter, sort, startTime, endTime }) =>
      jsonResult(
        await deps.client.platform.get(`${BASE}/vulnerabilities`, {
          ...(filter !== undefined && { filter }),
          ...(sort !== undefined && { sort }),
          ...(startTime !== undefined && { "start-time": startTime }),
          ...(endTime !== undefined && { "end-time": endTime }),
        }),
      ),
  );

  server.registerTool(
    "get_vulnerability",
    {
      description: "Get full details of a single vulnerability by its ID (Dynatrace Platform Vulnerabilities v1).",
      inputSchema: {
        id: z.string().describe("The vulnerability ID."),
        startTime: z
          .string()
          .optional()
          .describe('Start of timeframe. ISO-8601 timestamp or relative, e.g. "now-7d". Defaults to "now-30m".'),
        endTime: z.string().optional().describe('End of timeframe. Only "now" is supported. Defaults to "now".'),
      },
    },
    async ({ id, startTime, endTime }) =>
      jsonResult(
        await deps.client.platform.get(`${BASE}/vulnerabilities/${encodeURIComponent(id)}`, {
          ...(startTime !== undefined && { "start-time": startTime }),
          ...(endTime !== undefined && { "end-time": endTime }),
        }),
      ),
  );
}

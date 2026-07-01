import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

export function registerProblemsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_problems",
    {
      description:
        "List problems (classic Problems v2). Filter by status/severity via problemSelector and a timeframe. Returns one page; pass nextPageKey to page through results.",
      inputSchema: {
        problemSelector: z.string().optional().describe('e.g. status("OPEN"),severityLevel("AVAILABILITY").'),
        from: z.string().optional().describe("default 'now-2h'."),
        to: z.string().optional(),
        pageSize: z.number().int().positive().max(500).optional(),
        nextPageKey: z
          .string()
          .optional()
          .describe(
            "Opaque next-page cursor from a previous response's nextPageKey; when set, other filters are ignored (classic API requirement).",
          ),
      },
    },
    async ({ problemSelector, from, to, pageSize, nextPageKey }) =>
      jsonResult(
        await deps.client.classic.get(
          "/api/v2/problems",
          nextPageKey ? { nextPageKey } : { problemSelector, from: from ?? "now-2h", to, pageSize: pageSize ?? 50 },
        ),
      ),
  );

  server.registerTool(
    "get_problem",
    {
      description: "Get full details of one problem, including root cause and affected entities.",
      inputSchema: { problemId: z.string().describe("The problem id.") },
    },
    async ({ problemId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/problems/${encodeURIComponent(problemId)}`)),
  );
}

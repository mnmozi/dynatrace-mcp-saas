import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { escapeQuotes } from "../util/escape.js";

export function registerLogsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_logs",
    {
      description: "Search logs in Grail via DQL. Builds a 'fetch logs' query with optional filters. For advanced needs use execute_dql.",
      inputSchema: {
        contains: z.string().optional().describe("Substring to match in log content."),
        loglevel: z.string().optional().describe("e.g. 'ERROR', 'WARN'."),
        host: z.string().optional().describe("Host name to filter by (dt.host.name)."),
        from: z.string().optional().describe("DQL timeframe start expression, e.g. 'now()-1h' (default) or 'now()-24h'."),
        limit: z.number().int().positive().max(1000).optional().describe("Max rows (default 100)."),
      },
    },
    async ({ contains, loglevel, host, from, limit }) => {
      const filters: string[] = [];
      if (loglevel) filters.push(`loglevel == "${escapeQuotes(loglevel)}"`);
      if (host) filters.push(`dt.host.name == "${escapeQuotes(host)}"`);
      if (contains) filters.push(`contains(content, "${escapeQuotes(contains)}")`);
      let q = `fetch logs, from:${from ?? "now()-1h"}`;
      if (filters.length) q += ` | filter ${filters.join(" and ")}`;
      q += ` | sort timestamp desc | limit ${limit ?? 100}`;
      const result = await deps.client.dqlExecute(q, { maxResultRecords: limit ?? 100 });
      return jsonResult({ query: q, recordCount: result.records.length, records: result.records });
    },
  );
}

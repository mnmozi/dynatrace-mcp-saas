import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { escapeQuotes } from "../util/escape.js";

export function registerTracesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_spans",
    {
      description: "Search distributed-tracing spans in Grail via DQL ('fetch spans'). Filter by service, status, or duration.",
      inputSchema: {
        service: z.string().optional().describe("Service name (service.name)."),
        onlyErrors: z.boolean().optional().describe("If true, only failed spans."),
        minDurationMs: z.number().optional().describe("Minimum span duration in ms."),
        from: z.string().optional().describe("Timeframe start (default 'now-1h')."),
        limit: z.number().int().positive().max(1000).optional().describe("Max rows (default 100)."),
      },
    },
    async ({ service, onlyErrors, minDurationMs, from, limit }) => {
      const filters: string[] = [];
      if (service) filters.push(`service.name == "${escapeQuotes(service)}"`);
      if (onlyErrors) filters.push(`request.is_failed == true`);
      if (minDurationMs) filters.push(`duration >= ${minDurationMs}ms`);
      let q = `fetch spans, from:${from ?? "now-1h"}`;
      if (filters.length) q += ` | filter ${filters.join(" and ")}`;
      q += ` | sort duration desc | limit ${limit ?? 100}`;
      const result = await deps.client.dqlExecute(q, { maxResultRecords: limit ?? 100 });
      return jsonResult({ query: q, recordCount: result.records.length, records: result.records });
    },
  );

  server.registerTool(
    "get_trace",
    {
      description: "Fetch all spans for a single trace id (ordered by start time) for latency/root-cause analysis.",
      inputSchema: {
        traceId: z.string().describe("The trace.id value."),
        from: z.string().optional().describe("Timeframe start (default 'now-4h')."),
      },
    },
    async ({ traceId, from }) => {
      const q = `fetch spans, from:${from ?? "now-4h"} | filter trace.id == "${escapeQuotes(traceId)}" | sort start_time asc | limit 1000`;
      const result = await deps.client.dqlExecute(q, { maxResultRecords: 1000 });
      return jsonResult({ query: q, spanCount: result.records.length, spans: result.records });
    },
  );
}

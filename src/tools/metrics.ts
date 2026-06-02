import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

export function registerMetricsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_metrics",
    {
      description:
        "List/search metric descriptors (classic Metrics v2). Use a metricSelector like 'builtin:host.*' to filter.",
      inputSchema: {
        selector: z
          .string()
          .optional()
          .describe("metricSelector filter, e.g. 'builtin:host.cpu.*'."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Page size (default 100)."),
      },
    },
    async ({ selector, pageSize }) => {
      return jsonResult(
        await deps.client.classic.get("/api/v2/metrics", {
          metricSelector: selector,
          pageSize: pageSize ?? 100,
          fields: "metricId,displayName,unit,description,defaultAggregation",
        }),
      );
    },
  );

  server.registerTool(
    "get_metric_metadata",
    {
      description:
        "Get the descriptor/metadata for a single metric by key (classic Metrics v2).",
      inputSchema: {
        metricKey: z
          .string()
          .describe("The metric key, e.g. 'builtin:host.cpu.usage'."),
      },
    },
    async ({ metricKey }) => {
      return jsonResult(
        await deps.client.classic.get(
          `/api/v2/metrics/${encodeURIComponent(metricKey)}`,
        ),
      );
    },
  );

  server.registerTool(
    "query_metric",
    {
      description:
        "Query metric data points (classic Metrics v2). Returns timeseries for the given selector and timeframe.",
      inputSchema: {
        metricSelector: z
          .string()
          .describe("metricSelector, e.g. 'builtin:host.cpu.usage:avg'."),
        from: z
          .string()
          .optional()
          .describe("Start time, e.g. 'now-2h' or ISO-8601."),
        to: z
          .string()
          .optional()
          .describe("End time, e.g. 'now'."),
        resolution: z
          .string()
          .optional()
          .describe("Resolution, e.g. '1m', '1h'."),
        entitySelector: z
          .string()
          .optional()
          .describe("Optional entitySelector to scope results."),
      },
    },
    async ({ metricSelector, from, to, resolution, entitySelector }) => {
      return jsonResult(
        await deps.client.classic.get("/api/v2/metrics/query", {
          metricSelector,
          from,
          to,
          resolution,
          entitySelector,
        }),
      );
    },
  );
}

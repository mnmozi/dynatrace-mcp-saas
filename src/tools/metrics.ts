import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { DynatraceApiError } from "../http/errors.js";

export function registerMetricsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_metrics",
    {
      description:
        "List/search metric descriptors (classic Metrics v2). Use a metricSelector like 'builtin:host.*' to filter. On Gen3/Grail tenants this endpoint may be unavailable; use query_metric or execute_dql instead.",
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
      try {
        return jsonResult(
          await deps.client.classic.get("/api/v2/metrics", {
            metricSelector: selector,
            pageSize: pageSize ?? 100,
            fields: "metricId,displayName,unit,description,defaultAggregation",
          }),
        );
      } catch (e) {
        if (e instanceof DynatraceApiError && e.status === 403) {
          return jsonResult({
            unavailable: true,
            reason:
              "The classic Metrics v2 API requires the 'metrics.read' scope, which is not available on Gen3/Grail tenants.",
            useInstead:
              "Query metrics with the query_metric tool (Grail DQL 'timeseries') or execute_dql; browse metric keys in the Dynatrace Metrics app.",
          });
        }
        throw e;
      }
    },
  );

  server.registerTool(
    "get_metric_metadata",
    {
      description:
        "Get the descriptor/metadata for a single metric by key (classic Metrics v2). On Gen3/Grail tenants this endpoint may be unavailable; use query_metric or execute_dql instead.",
      inputSchema: {
        metricKey: z
          .string()
          .describe("The metric key, e.g. 'builtin:host.cpu.usage'."),
      },
    },
    async ({ metricKey }) => {
      try {
        return jsonResult(
          await deps.client.classic.get(
            `/api/v2/metrics/${encodeURIComponent(metricKey)}`,
          ),
        );
      } catch (e) {
        if (e instanceof DynatraceApiError && e.status === 403) {
          return jsonResult({
            unavailable: true,
            reason:
              "The classic Metrics v2 API requires the 'metrics.read' scope, which is not available on Gen3/Grail tenants.",
            useInstead:
              "Query metrics with the query_metric tool (Grail DQL 'timeseries') or execute_dql; browse metric keys in the Dynatrace Metrics app.",
          });
        }
        throw e;
      }
    },
  );

  server.registerTool(
    "query_metric",
    {
      description:
        "Query metric data points via Grail DQL 'timeseries' (Gen3-native, platform token). Builds a timeseries query and executes it against the Grail storage API. Works on all Gen3/Grail tenants with the storage:metrics:read scope.",
      inputSchema: {
        metricKey: z
          .string()
          .describe("Metric key, e.g. 'dt.host.cpu.usage'."),
        aggregation: z
          .string()
          .optional()
          .describe(
            "Aggregation: avg|sum|min|max|count|median|percentile etc. Default 'avg'.",
          ),
        by: z
          .array(z.string())
          .optional()
          .describe(
            "Dimensions to split by, e.g. ['dt.entity.host'].",
          ),
        filter: z
          .string()
          .optional()
          .describe(
            "Optional DQL filter expression, e.g. 'dt.entity.host == \"HOST-123\"'.",
          ),
        from: z
          .string()
          .optional()
          .describe("DQL timeframe start (default 'now()-1h')."),
        to: z
          .string()
          .optional()
          .describe("DQL timeframe end (default 'now()')."),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional(),
      },
    },
    async ({ metricKey, aggregation, by, filter, from, to, limit }) => {
      const agg = aggregation ?? "avg";
      let q = `timeseries ${agg}(${metricKey})`;
      if (by && by.length) q += `, by:{${by.join(", ")}}`;
      if (filter) q += `, filter:{${filter}}`;
      q += `, from:${from ?? "now()-1h"}`;
      if (to) q += `, to:${to}`;
      if (limit) q += ` | limit ${limit}`;
      const result = await deps.client.dqlExecute(q, { maxResultRecords: limit ?? 1000 });
      return jsonResult({ query: q, recordCount: result.records.length, records: result.records });
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import type { DynatraceClient } from "../http/client.js";
import { jsonResult } from "../util/result.js";
import { runGeneratedDql } from "../util/generated-dql.js";
import { escapeQuotes } from "../util/escape.js";
import { DynatraceApiError } from "../http/errors.js";

const DEFAULT_METRIC_PAGE_SIZE = 100;

/** A 403 from classic Metrics v2: point to the Grail route, and keep what Dynatrace itself said. */
function classicMetricsUnavailable(denied: DynatraceApiError) {
  return jsonResult({
    unavailable: true,
    reason:
      "The classic Metrics v2 API requires the 'metrics.read' scope, which is not available on Gen3/Grail tenants.",
    dynatraceError: denied.message,
    useInstead:
      "Find metric keys with list_metrics with search (Grail 'fetch metric.series'; a classic selector cannot be " +
      "translated, Grail keys are named differently, e.g. dt.host.cpu.usage). Query data points with the " +
      "query_metric tool (Grail DQL 'timeseries') or execute_dql.",
  });
}

const isDenied = (error: unknown): error is DynatraceApiError =>
  error instanceof DynatraceApiError && error.status === 403;

/** Metric keys reporting in Grail's default metric.series window whose key contains `search`. */
async function searchGrailMetricKeys(client: DynatraceClient, search: string, limit: number) {
  const query =
    `fetch metric.series | filter contains(metric.key, "${escapeQuotes(search)}", caseSensitive:false) ` +
    `| summarize series = count(), by:{metric.key} | sort metric.key asc | limit ${limit}`;
  const result = await runGeneratedDql(client, query, limit);
  return { source: "grail", query, recordCount: result.records.length, records: result.records };
}

export function registerMetricsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_metrics",
    {
      description:
        "List/search metrics. On Gen3/Grail tenants pass search: it finds metric keys in Grail " +
        "('fetch metric.series', platform token with storage:metrics:read) and returns each key with its series " +
        "count. selector is the classic Metrics v2 metricSelector (e.g. 'builtin:host.*'); it needs the classic " +
        "'metrics.read' scope, which Gen3/Grail tenants do not have. With both set, search is the fallback when " +
        "the classic API answers 403.",
      inputSchema: {
        search: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Text the metric key must contain (case-insensitive), answered from Grail, e.g. 'host.cpu'. " +
              "Covers metrics that reported in Grail's default metric.series window (last 2 hours).",
          ),
        selector: z.string().optional().describe("Classic metricSelector filter, e.g. 'builtin:host.cpu.*'."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe(`Max metrics to return (default ${DEFAULT_METRIC_PAGE_SIZE}).`),
      },
    },
    async ({ search, selector, pageSize }) => {
      const limit = pageSize ?? DEFAULT_METRIC_PAGE_SIZE;
      if (search && !selector) {
        return jsonResult(await searchGrailMetricKeys(deps.client, search, limit));
      }
      try {
        return jsonResult(
          await deps.client.classic.get("/api/v2/metrics", {
            metricSelector: selector,
            pageSize: limit,
            fields: "metricId,displayName,unit,description,defaultAggregation",
          }),
        );
      } catch (e) {
        if (!isDenied(e)) throw e;
        if (!search) return classicMetricsUnavailable(e);
        return jsonResult({ ...(await searchGrailMetricKeys(deps.client, search, limit)), dynatraceError: e.message });
      }
    },
  );

  server.registerTool(
    "get_metric_metadata",
    {
      description:
        "Get the descriptor/metadata for a single metric by key (classic Metrics v2). On Gen3/Grail tenants this endpoint may be unavailable; use query_metric or execute_dql instead.",
      inputSchema: {
        metricKey: z.string().describe("The metric key, e.g. 'builtin:host.cpu.usage'."),
      },
    },
    async ({ metricKey }) => {
      try {
        return jsonResult(await deps.client.classic.get(`/api/v2/metrics/${encodeURIComponent(metricKey)}`));
      } catch (e) {
        if (isDenied(e)) return classicMetricsUnavailable(e);
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
        metricKey: z.string().describe("Metric key, e.g. 'dt.host.cpu.usage'."),
        aggregation: z
          .string()
          .optional()
          .describe("Aggregation: avg|sum|min|max|count|median|percentile etc. Default 'avg'."),
        by: z.array(z.string()).optional().describe("Dimensions to split by, e.g. ['dt.entity.host']."),
        filter: z
          .string()
          .optional()
          .describe("Optional DQL filter expression, e.g. 'dt.entity.host == \"HOST-123\"'."),
        from: z.string().optional().describe("DQL timeframe start (default 'now()-1h')."),
        to: z.string().optional().describe("DQL timeframe end (default 'now()')."),
        limit: z.number().int().positive().max(1000).optional(),
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
      const result = await runGeneratedDql(deps.client, q, limit ?? 1000);
      return jsonResult({ query: q, recordCount: result.records.length, records: result.records });
    },
  );
}

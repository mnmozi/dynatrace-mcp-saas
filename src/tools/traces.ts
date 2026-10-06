import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { runGeneratedDql } from "../util/generated-dql.js";
import { escapeQuotes } from "../util/escape.js";
import { listAllSettingsObjects, type SettingsObject } from "../util/settings-objects.js";
import { settingsScopeSchema } from "../schemas/settings.js";

/** The Settings 2.0 schemas that decide how many traces are captured and kept. */
const TRACE_SAMPLING_SCHEMA_IDS = [
  "builtin:trace.ingest.control",
  "builtin:global.trace.ingest.control",
  "builtin:url-based-sampling",
  "builtin:rpc-based-sampling",
] as const;

type SamplingObject = Pick<SettingsObject, "objectId" | "value">;

/** Every sampling schema gets an entry, so a schema with nothing set at the scope reads as []. */
function groupBySamplingSchema(objects: SettingsObject[]): Record<string, SamplingObject[]> {
  const bySchema: Record<string, SamplingObject[]> = Object.fromEntries(
    TRACE_SAMPLING_SCHEMA_IDS.map((schemaId) => [schemaId, []]),
  );
  for (const { schemaId, objectId, value } of objects) {
    (bySchema[schemaId] ??= []).push({ objectId, value });
  }
  return bySchema;
}

export function registerTracesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_spans",
    {
      description:
        "Search distributed-tracing spans in Grail via DQL ('fetch spans'). Filter by service, status, or duration.",
      inputSchema: {
        service: z.string().optional().describe("Service name (service.name)."),
        onlyErrors: z.boolean().optional().describe("If true, only failed spans."),
        minDurationMs: z.number().optional().describe("Minimum span duration in ms."),
        from: z.string().optional().describe("DQL timeframe start expression (default 'now()-1h')."),
        limit: z.number().int().positive().max(1000).optional().describe("Max rows (default 100)."),
      },
    },
    async ({ service, onlyErrors, minDurationMs, from, limit }) => {
      const filters: string[] = [];
      if (service) filters.push(`service.name == "${escapeQuotes(service)}"`);
      if (onlyErrors) filters.push(`request.is_failed == true`);
      if (minDurationMs) filters.push(`duration >= ${minDurationMs}ms`);
      let q = `fetch spans, from:${from ?? "now()-1h"}`;
      if (filters.length) q += ` | filter ${filters.join(" and ")}`;
      q += ` | sort duration desc | limit ${limit ?? 100}`;
      const result = await runGeneratedDql(deps.client, q, limit ?? 100);
      return jsonResult({ query: q, recordCount: result.records.length, records: result.records });
    },
  );

  server.registerTool(
    "get_trace",
    {
      description: "Fetch all spans for a single trace id (ordered by start time) for latency/root-cause analysis.",
      inputSchema: {
        traceId: z.string().describe("The trace.id value."),
        from: z.string().optional().describe("DQL timeframe start expression (default 'now()-4h')."),
      },
    },
    async ({ traceId, from }) => {
      const q = `fetch spans, from:${from ?? "now()-4h"} | filter trace.id == "${escapeQuotes(traceId)}" | sort start_time asc | limit 1000`;
      const result = await runGeneratedDql(deps.client, q, 1000);
      return jsonResult({ query: q, spanCount: result.records.length, spans: result.records });
    },
  );

  server.registerTool(
    "get_trace_sampling_config",
    {
      description:
        "Summarise the trace sampling configuration set at one scope in a single call: the Settings 2.0 objects of " +
        "builtin:trace.ingest.control, builtin:global.trace.ingest.control, builtin:url-based-sampling and " +
        "builtin:rpc-based-sampling, grouped by schema. A schema listed with [] has nothing set AT that scope " +
        "(the value inherited from a parent scope, or the schema default, then applies). " +
        "For the meaning of each field call get_settings_schema.",
      inputSchema: {
        scope: settingsScopeSchema,
      },
    },
    async ({ scope }) => {
      const objects = await listAllSettingsObjects(deps.client.classic, {
        schemaIds: TRACE_SAMPLING_SCHEMA_IDS,
        scope,
      });
      return jsonResult({ scope, objectCount: objects.length, schemas: groupBySamplingSchema(objects) });
    },
  );
}

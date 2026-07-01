import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

// NOTE: metrics ingest (POST /api/v2/metrics/ingest) is intentionally omitted —
// it uses text/plain line protocol which the JSON-only client cannot send.

export function registerIngestTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "ingest_logs",
    {
      description:
        "Ingest one or more log records into Dynatrace via POST /api/v2/logs/ingest (WRITE). " +
        "Requires DT_ENABLE_WRITES=true and a classic API token with the `logs.ingest` scope.",
      inputSchema: {
        logs: z
          .union([z.record(z.unknown()), z.array(z.record(z.unknown()))])
          .describe("A log record or array of log records (JSON)."),
      },
    },
    async ({ logs }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.post("/api/v2/logs/ingest", logs));
    },
  );

  server.registerTool(
    "ingest_events",
    {
      description:
        "Ingest a custom event into Dynatrace via POST /api/v2/events/ingest (WRITE). " +
        "Requires DT_ENABLE_WRITES=true and a classic API token with the `events.ingest` scope. " +
        "Required fields: eventType (e.g. CUSTOM_INFO, CUSTOM_DEPLOYMENT, AVAILABILITY_EVENT), title. " +
        "Optional: entitySelector, properties (key/value map), startTime, endTime, timeout.",
      inputSchema: {
        event: z.record(z.unknown()).describe("Event payload: eventType, title, properties, etc. per spec"),
      },
    },
    async ({ event }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.post("/api/v2/events/ingest", event));
    },
  );

  server.registerTool(
    "ingest_bizevents",
    {
      description:
        "Ingest a business event (CloudEvent) into Dynatrace via POST /api/v2/bizevents/ingest (WRITE). " +
        "Requires DT_ENABLE_WRITES=true and a classic API token with the `bizevents.ingest` scope. " +
        "Required CloudEvent fields: id, source, specversion, type. " +
        "Optional: data, datacontenttype, dataschema, dtcontext, subject, time, traceparent.",
      inputSchema: {
        bizevent: z.record(z.unknown()).describe("Business event payload per spec"),
      },
    },
    async ({ bizevent }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.post("/api/v2/bizevents/ingest", bizevent));
    },
  );
}

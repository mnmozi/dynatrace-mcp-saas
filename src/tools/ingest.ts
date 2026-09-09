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
      // Data ingest is append-only with no stable record identity — never retry on
      // 5xx/network (a retry would duplicate the record). Only 429/408 (pre-processing) retry.
      return jsonResult(await deps.client.classic.post("/api/v2/logs/ingest", logs, undefined, { retryClass: "append" }));
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
      return jsonResult(
        await deps.client.classic.post("/api/v2/events/ingest", event, undefined, { retryClass: "append" }),
      );
    },
  );

  server.registerTool(
    "ingest_bizevents",
    {
      description:
        "Ingest one or more business events via POST /api/v2/bizevents/ingest (WRITE). " +
        "Requires DT_ENABLE_WRITES=true and a classic API token with the `bizevents.ingest` scope.\n" +
        "TWO payload formats (the Content-Type is set for you):\n" +
        "• DEFAULT (cloudEvent omitted/false) → application/json: pass fields DIRECTLY with LITERAL bizevent keys, " +
        'e.g. { "event.type": "order.attempt", "event.provider": "checkout", "amount": 42 }. ' +
        "There are no mandatory fields; event.type/event.provider become the record's fields as-is. USE THIS unless " +
        "you specifically have a CloudEvent envelope.\n" +
        "• cloudEvent:true → application/cloudevent+json (single) or application/cloudevents-batch+json (array): pass a " +
        "CloudEvent ENVELOPE with specversion, source (→event.provider), type (→event.type), id (→event.id), and payload " +
        "under a `data` object.\n" +
        "IMPORTANT: the envelope keys (source/type/specversion) ONLY work with cloudEvent:true. Sending them as plain " +
        "JSON produces junk records with event.type='unknown' — use the literal event.type/event.provider keys instead.",
      inputSchema: {
        bizevent: z
          .union([z.record(z.unknown()), z.array(z.record(z.unknown()))])
          .describe(
            'Plain format: {"event.type":"...","event.provider":"...", ...}. CloudEvent format (cloudEvent:true): {specversion,source,type,id,data:{...}}. Array = batch.',
          ),
        cloudEvent: z
          .boolean()
          .optional()
          .describe("If true, send as a CloudEvent envelope (application/cloudevent+json / -batch for arrays)."),
      },
    },
    async ({ bizevent, cloudEvent }) => {
      requireWrites(deps.config);
      const contentType = cloudEvent
        ? Array.isArray(bizevent)
          ? "application/cloudevents-batch+json"
          : "application/cloudevent+json"
        : "application/json";
      return jsonResult(
        await deps.client.classic.post("/api/v2/bizevents/ingest", bizevent, undefined, {
          retryClass: "append",
          contentType,
        }),
      );
    },
  );

  // ── OpenPipeline ingest (/platform/ingest/*) ───────────────────────────────
  // NOTE ON HOST: these /platform/ingest/* endpoints are DATA-PLANE ingest and live
  // on the ENVIRONMENT/classic host (…dynatracelabs.com), NOT the apps host
  // (…apps.dynatracelabs.com). So they route through the classic client (same host +
  // Api-Token as ingest_logs/ingest_events) — only the request PATH is /platform/*.
  // The classic API token must carry the matching openpipeline.* scope.
  // application/json for all of these.
  const OPENPIPELINE_INGEST: Record<string, { path: string; scope: string; customCategory: string | null }> = {
    events: { path: "events", scope: "openpipeline.events", customCategory: "events" },
    sdlc: { path: "events.sdlc", scope: "openpipeline.sdlc", customCategory: "events.sdlc" },
    security: { path: "security.events", scope: "openpipeline.events_security", customCategory: "security.events" },
    smartscape: { path: "smartscape.events", scope: "openpipeline.events_smartscape", customCategory: null },
  };

  server.registerTool(
    "ingest_openpipeline_events",
    {
      description:
        "Ingest events into the PLATFORM OpenPipeline ingest API (WRITE) — the platform-native counterpart to the " +
        "classic ingest_events, routed through OpenPipeline. Choose dataType: 'events' → POST /platform/ingest/v1/events, " +
        "'sdlc' → /platform/ingest/v1/events.sdlc, 'security' → /platform/ingest/v1/security.events, " +
        "'smartscape' → /platform/ingest/v1/smartscape.events. Set customEndpoint to target a custom ingest source " +
        "(POST /platform/ingest/custom/<category>/<customEndpoint>; not available for smartscape). Accepts a single " +
        "event object or an array. These endpoints are served on the ENVIRONMENT (classic) host, not the apps host. " +
        "Each event should carry an `event.id` (the docs' request shape requires it) plus any custom fields. " +
        "Requires DT_ENABLE_WRITES=true and a classic API token (DT_API_TOKEN) carrying the matching Api-Token scope " +
        "(events→openpipeline.events, sdlc→openpipeline.sdlc, security→openpipeline.events_security, " +
        "smartscape→openpipeline.events_smartscape; custom endpoints use the .custom variant of that scope). " +
        "NOTE: these endpoints also accept a Platform token with the IAM colon-style equivalent " +
        "(e.g. openpipeline:events:ingest, openpipeline:security.events:ingest) — that is the 'new' security-events " +
        "auth style; the request PATH is identical for legacy and new. This tool uses the Api-Token path.",
      inputSchema: {
        dataType: z
          .enum(["events", "sdlc", "security", "smartscape"])
          .describe("Which built-in OpenPipeline ingest endpoint to target."),
        events: z
          .union([z.record(z.unknown()), z.array(z.record(z.unknown()))])
          .describe("An event object or an array of event objects (JSON)."),
        customEndpoint: z
          .string()
          .optional()
          .describe("If set, ingest to a CUSTOM endpoint of this dataType's category (not supported for smartscape)."),
      },
    },
    async ({ dataType, events, customEndpoint }) => {
      requireWrites(deps.config);
      const cfg = OPENPIPELINE_INGEST[dataType];
      let path: string;
      if (customEndpoint) {
        if (!cfg.customCategory) {
          throw new Error(`Custom ingest endpoints are not supported for dataType='${dataType}'.`);
        }
        path = `/platform/ingest/custom/${cfg.customCategory}/${encodeURIComponent(customEndpoint)}`;
      } else {
        path = `/platform/ingest/v1/${cfg.path}`;
      }
      // Append-only ingest: never retry on 5xx/network (would duplicate); 429/408 only.
      // Classic host (environment domain) — /platform/ingest/* is NOT on the apps host.
      return jsonResult(await deps.client.classic.post(path, events, undefined, { retryClass: "append" }));
    },
  );
}

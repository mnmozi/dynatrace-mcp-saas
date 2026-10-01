import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { DynatraceApiError } from "../http/errors.js";

interface GrailNotification {
  severity?: string;
  notificationType?: string;
  message?: string;
}

/**
 * Pull the parts of Grail's result metadata worth showing: notifications are the
 * warnings a dashboard tile displays (e.g. "The number of entity IDs in the
 * relationship fields has been limited"), scannedBytes is what DPS bills on.
 * Keys are omitted when absent so clean results stay unchanged.
 */
export function grailInfo(metadata?: Record<string, unknown>): Record<string, unknown> {
  const grail = (metadata?.grail ?? {}) as { notifications?: GrailNotification[]; scannedBytes?: number };
  const warnings = (grail.notifications ?? []).map((n) => ({
    severity: n.severity,
    type: n.notificationType,
    message: n.message,
  }));
  return {
    ...(warnings.length ? { warnings } : {}),
    ...(typeof grail.scannedBytes === "number" ? { scannedBytes: grail.scannedBytes } : {}),
  };
}

/**
 * Turn a thrown DQL error into a structured, AI- and human-readable result.
 * Surfaces Dynatrace's own validation detail (human message, error type, and the
 * exact line/column) instead of the generic "request failed" envelope.
 */
function dqlErrorResult(e: unknown): ReturnType<typeof jsonResult> {
  if (e instanceof DynatraceApiError) {
    const d = e.detail;
    return jsonResult({
      ok: false,
      error: d.message ?? e.message,
      ...(d.errorType ? { errorType: d.errorType } : {}),
      ...(d.exceptionType ? { exceptionType: d.exceptionType } : {}),
      ...(d.position ? { position: d.position } : {}),
    });
  }
  return jsonResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
}

export function registerDqlTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "execute_dql",
    {
      description:
        "Execute a Dynatrace Query Language (DQL) statement against Grail and return the result records. " +
        "Use for logs, spans/traces, events, metrics, and entities. " +
        "Example: 'fetch logs | filter loglevel == \"ERROR\" | limit 50'. " +
        "Returns `warnings` when Grail attaches notifications (the same warnings a dashboard tile shows) " +
        "and `scannedBytes` (what DPS bills on). " +
        "If you are unsure of DQL syntax, call dql_reference first for embedded Grail DQL knowledge.",
      inputSchema: {
        query: z.string().describe("The DQL statement to execute."),
        maxResultRecords: z
          .number()
          .int()
          .positive()
          .max(10000)
          .optional()
          .describe("Max records to return (default 1000)."),
      },
    },
    async ({ query, maxResultRecords }) => {
      try {
        const result = await deps.client.dqlExecute(query, { maxResultRecords });
        return jsonResult({ recordCount: result.records.length, ...grailInfo(result.metadata), records: result.records });
      } catch (e) {
        return dqlErrorResult(e);
      }
    },
  );

  server.registerTool(
    "verify_dql",
    {
      description:
        "Validate a DQL statement without returning data (executes with limit 0). " +
        "Returns ok=true, or ok=false with Dynatrace's validation detail: a human-readable " +
        "error message, errorType (e.g. FIELD_DOES_NOT_EXIST), and the exact line/column.",
      inputSchema: {
        query: z.string().describe("The DQL statement to validate."),
      },
    },
    async ({ query }) => {
      try {
        const result = await deps.client.dqlExecute(`${query} | limit 0`, { maxResultRecords: 1 });
        const { warnings } = grailInfo(result.metadata);
        return jsonResult({ ok: true, ...(warnings ? { warnings } : {}) });
      } catch (e) {
        return dqlErrorResult(e);
      }
    },
  );
}

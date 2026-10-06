import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonErrorResult, jsonResult } from "../util/result.js";
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
 * Grail rejected the query itself (syntax, unknown field, wrong type). Auth, rate-limit,
 * server and transport failures are not query problems: callers rethrow those so the
 * standard message (status, host, token hint) reaches the caller intact.
 */
function isQueryRejection(e: unknown): e is DynatraceApiError {
  if (!(e instanceof DynatraceApiError) || e.status !== 400) return false;
  const { errorType, exceptionType, position } = e.detail;
  return Boolean(errorType || exceptionType || position);
}

/** Dynatrace's own validation detail: human message, error type, and the exact line/column. */
function queryRejection(e: DynatraceApiError) {
  const { message, errorType, exceptionType, position } = e.detail;
  return {
    ok: false,
    error: message ?? errorType ?? e.message,
    ...(errorType ? { errorType } : {}),
    ...(exceptionType ? { exceptionType } : {}),
    ...(position ? { position } : {}),
  };
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
        "A query Grail rejects returns ok=false with its message, errorType and the exact line/column. " +
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
        return jsonResult({
          recordCount: result.records.length,
          ...grailInfo(result.metadata),
          records: result.records,
        });
      } catch (e) {
        if (!isQueryRejection(e)) throw e;
        return jsonErrorResult(queryRejection(e));
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
        if (!isQueryRejection(e)) throw e;
        // A rejected query is this tool's answer, not a failure of the tool.
        return jsonResult(queryRejection(e));
      }
    },
  );
}

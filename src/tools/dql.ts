import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { DynatraceApiError } from "../http/errors.js";

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
        return jsonResult({ recordCount: result.records.length, records: result.records });
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
        await deps.client.dqlExecute(`${query} | limit 0`, { maxResultRecords: 1 });
        return jsonResult({ ok: true });
      } catch (e) {
        return dqlErrorResult(e);
      }
    },
  );
}

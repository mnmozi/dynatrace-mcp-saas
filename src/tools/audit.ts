import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

/**
 * Audit Logs tools — classic Environment API v2 surface.
 * Requires the classic token's `auditLogs.read` scope.
 *
 * Note: /api/v2/auditlogs is not present in the bundled spec snapshot, but the
 * AuditLog/AuditLogEntry schemas and auditLogs.read scope are confirmed in the spec.
 * The endpoint is part of the standard Dynatrace Environment API v2 surface.
 */
export function registerAuditTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_audit_logs",
    {
      description:
        "List audit log entries (classic Audit Logs API, requires auditLogs.read token scope). " +
        "Returns the `auditLogs` array. Supports time-range filtering via `from`/`to` and a " +
        "free-text `filter` query. Uses the classic Environment API v2: GET /api/v2/auditlogs. " +
        "Returns one page; pass nextPageKey to page through results.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Filter expression, e.g. category("CONFIG") or user("admin@example.com").'),
        from: z
          .string()
          .optional()
          .describe("Start of the timeframe. Accepts UTC ms, ISO 8601, or relative (e.g. now-1h). Default: now-2h."),
        to: z
          .string()
          .optional()
          .describe("End of the timeframe. Accepts UTC ms, ISO 8601, or relative. Default: now."),
        pageSize: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Number of entries per page (max 1000). Default: 50."),
        nextPageKey: z
          .string()
          .optional()
          .describe(
            "Opaque next-page cursor from a previous response's nextPageKey; when set, other filters are ignored (classic API requirement).",
          ),
      },
    },
    async ({ filter, from, to, pageSize, nextPageKey }) =>
      jsonResult(
        await deps.client.classic.get(
          "/api/v2/auditlogs",
          nextPageKey ? { nextPageKey } : { filter, from: from ?? "now-2h", to, pageSize: pageSize ?? 50 },
        ),
      ),
  );

  server.registerTool(
    "get_audit_log",
    {
      description:
        "Get a single audit log entry by its log ID (classic Audit Logs API, requires auditLogs.read scope). " +
        "Uses GET /api/v2/auditlogs/{id}.",
      inputSchema: {
        id: z.string().describe("The log entry ID (logId field)."),
      },
    },
    async ({ id }) => jsonResult(await deps.client.classic.get(`/api/v2/auditlogs/${encodeURIComponent(id)}`)),
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/storage/record/v1";

/** Shared body schema for status/cancel: just a taskId. */
const taskIdSchema = z.object({
  taskId: z.string().min(1).describe("The task ID returned by execute_record_deletion."),
});

/** TimeFrame object per spec: both start and end are required when provided. */
const timeFrameSchema = z.object({
  start: z
    .string()
    .min(1)
    .describe("Start of the time frame in ISO 8601 / RFC-3339 format, e.g. '2024-04-04T00:00:00Z'."),
  end: z.string().min(1).describe("End of the time frame in ISO 8601 / RFC-3339 format, e.g. '2024-04-04T01:00:00Z'."),
});

export function registerRecordDeletionTools(server: McpServer, deps: ToolDeps): void {
  // ── READ: status ──────────────────────────────────────────────────────────────

  server.registerTool(
    "get_record_deletion_status",
    {
      description:
        "Get the status of a previously submitted Grail record deletion process. " +
        "POST /platform/storage/record/v1/delete:status with the taskId from execute_record_deletion. " +
        "Returns one of: finished, submitted, processing, unknown, or failed, plus optional progress and message fields. " +
        "Required scopes: storage:records:delete, storage:events:read, storage:logs:read, " +
        "storage:bizevents:read, storage:spans:read, storage:buckets:read.",
      inputSchema: {
        taskId: z.string().min(1).describe("The task ID returned by execute_record_deletion."),
      },
    },
    async ({ taskId }) => jsonResult(await deps.client.platform.post(`${BASE}/delete:status`, { taskId })),
  );

  // ── WRITE: execute (DESTRUCTIVE) ──────────────────────────────────────────────

  server.registerTool(
    "execute_record_deletion",
    {
      description:
        "DESTRUCTIVE — permanently deletes Grail records matching the given DQL query and optional timeframe. " +
        "Data that is deleted CANNOT be restored. " +
        "Timeframe length is limited to 24 hours; end time must be at least 4 hours in the past. " +
        "Subsequent requests are queued and executed in order. " +
        "Returns a taskId to track deletion progress via get_record_deletion_status. " +
        "Requires DT_ENABLE_WRITES=true. " +
        "Required scopes: storage:records:delete, storage:events:read, storage:logs:read, " +
        "storage:bizevents:read, storage:spans:read, storage:buckets:read. " +
        "Allowed query commands: fetch, fields, fieldsAdd, fieldsRemove, filter, parse.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "DQL query that selects the records to delete. " +
              'Example: "fetch logs | filter contains(content, \\"delete_records_test\\")"',
          ),
        timeFrame: timeFrameSchema
          .optional()
          .describe(
            "Optional explicit time frame for the deletion. " +
              "Ignored if the query already contains a timeframe clause. " +
              "Both start and end are required when this object is provided.",
          ),
        timezone: z.string().optional().describe("Timezone for the query. Defaults to 'UTC'."),
        locale: z.string().optional().describe("Locale for the query. Defaults to 'en-US'."),
      },
    },
    async ({ query, timeFrame, timezone, locale }) => {
      requireWrites(deps.config);
      const body: Record<string, unknown> = { query };
      if (timeFrame !== undefined) body.timeFrame = timeFrame;
      if (timezone !== undefined) body.timezone = timezone;
      if (locale !== undefined) body.locale = locale;
      return jsonResult(await deps.client.platform.post(`${BASE}/delete:execute`, body));
    },
  );

  // ── WRITE: cancel ─────────────────────────────────────────────────────────────

  server.registerTool(
    "cancel_record_deletion",
    {
      description:
        "Cancel a Grail record deletion process that is in progress or queued. " +
        "Cancels subtasks that have not started yet; already-deleted data is NOT restored. " +
        "Requires DT_ENABLE_WRITES=true. " +
        "Required scopes: storage:records:delete, storage:events:read, storage:logs:read, " +
        "storage:bizevents:read, storage:spans:read, storage:buckets:read.",
      inputSchema: {
        taskId: taskIdSchema.shape.taskId,
      },
    },
    async ({ taskId }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(`${BASE}/delete:cancel`, { taskId }));
    },
  );
}

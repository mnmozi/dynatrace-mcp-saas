import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/storage/filter-segments/v1/filter-segments";

export function registerFilterSegmentTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_filter_segments",
    {
      description:
        "List all Grail filter segments (platform storage filter-segments v1). " +
        "The API hides optional fields by default — pass addFields to include them " +
        "(the list endpoint supports VARIABLES, EXTERNALID, RESOURCECONTEXT; use get_filter_segment for INCLUDES).",
      inputSchema: {
        addFields: z
          .array(z.enum(["VARIABLES", "EXTERNALID", "RESOURCECONTEXT"]))
          .optional()
          .describe("Optional fields to include in each segment (sent as add-fields)."),
      },
    },
    async ({ addFields }) =>
      jsonResult(await deps.client.platform.get(BASE, addFields?.length ? { "add-fields": addFields } : undefined)),
  );

  server.registerTool(
    "get_filter_segment",
    {
      description:
        "Get a filter segment by UID (platform storage filter-segments v1). " +
        "The API hides the segment's content by default; this tool requests add-fields=INCLUDES,VARIABLES " +
        "unless addFields overrides it, so the full definition is returned.",
      inputSchema: {
        uid: z.string(),
        addFields: z
          .array(z.enum(["INCLUDES", "VARIABLES", "EXTERNALID", "RESOURCECONTEXT"]))
          .optional()
          .describe("Optional fields to include (default: INCLUDES, VARIABLES). Pass [] to fetch metadata only."),
      },
    },
    async ({ uid, addFields }) => {
      const fields = addFields ?? ["INCLUDES", "VARIABLES"];
      return jsonResult(
        await deps.client.platform.get(
          `${BASE}/${encodeURIComponent(uid)}`,
          fields.length ? { "add-fields": fields } : undefined,
        ),
      );
    },
  );

  server.registerTool(
    "create_filter_segment",
    {
      description:
        "Create a new filter segment (WRITE, platform storage filter-segments v1). " +
        "Requires storage:filter-segments:write scope.",
      inputSchema: {
        filterSegment: z
          .record(z.unknown())
          .describe("Filter segment definition: name, variables, dql/filter, etc. per spec"),
      },
    },
    async ({ filterSegment }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(BASE, filterSegment));
    },
  );

  server.registerTool(
    "update_filter_segment",
    {
      description:
        "Update (replace) a filter segment by UID (WRITE, platform storage filter-segments v1). " +
        "All fields are overwritten. The API requires the current version as the optimistic-locking-version " +
        "QUERY parameter (get it from get_filter_segment). Requires storage:filter-segments:write scope.",
      inputSchema: {
        uid: z.string(),
        version: z
          .number()
          .int()
          .positive()
          .describe("Current optimistic-locking version of the segment (from get_filter_segment)."),
        filterSegment: z
          .record(z.unknown())
          .describe("Full filter segment body to replace the existing one (name, isPublic, includes, etc.)."),
      },
    },
    async ({ uid, version, filterSegment }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(`${BASE}/${encodeURIComponent(uid)}`, filterSegment, {
          "optimistic-locking-version": version,
        }),
      );
    },
  );

  server.registerTool(
    "delete_filter_segment",
    {
      description:
        "Delete a filter segment by UID (WRITE, destructive, platform storage filter-segments v1). " +
        "Requires storage:filter-segments:delete scope.",
      inputSchema: { uid: z.string() },
    },
    async ({ uid }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${BASE}/${encodeURIComponent(uid)}`));
    },
  );
}

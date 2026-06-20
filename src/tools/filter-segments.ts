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
      description: "List all Grail filter segments (platform storage filter-segments v1).",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(BASE)),
  );

  server.registerTool(
    "get_filter_segment",
    {
      description: "Get a filter segment by UID (platform storage filter-segments v1).",
      inputSchema: { uid: z.string() },
    },
    async ({ uid }) =>
      jsonResult(await deps.client.platform.get(`${BASE}/${encodeURIComponent(uid)}`)),
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
          .describe(
            "Filter segment definition: name, variables, dql/filter, etc. per spec",
          ),
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
        "All fields are overwritten. Requires storage:filter-segments:write scope.",
      inputSchema: {
        uid: z.string(),
        filterSegment: z
          .record(z.unknown())
          .describe(
            "Full filter segment body to replace the existing one (name, isPublic, includes, etc.).",
          ),
      },
    },
    async ({ uid, filterSegment }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(`${BASE}/${encodeURIComponent(uid)}`, filterSegment),
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
      return jsonResult(
        await deps.client.platform.del(`${BASE}/${encodeURIComponent(uid)}`),
      );
    },
  );
}

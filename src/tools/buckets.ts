import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/storage/management/v1/bucket-definitions";

const WRITE_NOTE = "Requires DT_ENABLE_WRITES=true and the platform scope storage:bucket-definitions:write.";

export function registerBucketTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_grail_buckets",
    {
      description:
        "List all Grail retention bucket definitions (Dynatrace Storage Management v1). " +
        "Returns the full bucket array including bucketName, table, retentionDays, status, etc.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(BASE)),
  );

  server.registerTool(
    "get_grail_bucket",
    {
      description: "Get a single Grail retention bucket definition by name (Dynatrace Storage Management v1).",
      inputSchema: { bucketName: z.string().describe("The unique bucket name to retrieve.") },
    },
    async ({ bucketName }) => jsonResult(await deps.client.platform.get(`${BASE}/${encodeURIComponent(bucketName)}`)),
  );

  server.registerTool(
    "create_grail_bucket",
    {
      description: "Create a new custom Grail retention bucket (WRITE, Dynatrace Storage Management v1). " + WRITE_NOTE,
      inputSchema: {
        bucket: z
          .record(z.unknown())
          .describe(
            "Bucket definition per Storage Management v1 spec. " +
              "Required fields: bucketName (3-100 chars, lowercase letters/digits/underscores/hyphens, must start with a letter, must not start with 'default_' or 'dt_'), " +
              "table (one of: logs, events, bizevents, spans, security.events, user.sessions, user.events), " +
              "retentionDays (1-3657). " +
              "Optional: displayName (up to 200 chars), bucketClass ('live' or 'historic', defaults to 'live'), " +
              "includedQueryLimitDays (>=0), metricInterval (metric buckets only: PT1M, PT5M, PT15M, PT1H).",
          ),
      },
    },
    async ({ bucket }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(BASE, bucket));
    },
  );

  server.registerTool(
    "update_grail_bucket",
    {
      description:
        "Update a Grail retention bucket by name (WRITE, Dynatrace Storage Management v1). " +
        "Uses an optimistic-locking PUT; include the current 'version' in the bucket body. " +
        WRITE_NOTE,
      inputSchema: {
        bucketName: z.string().describe("The bucket name to update."),
        bucket: z
          .record(z.unknown())
          .describe(
            "Full bucket update body per Storage Management v1 spec (UpdateBucket schema). " +
              "Mutable fields: displayName, retentionDays, includedQueryLimitDays. " +
              "Must include 'version' (current optimistic locking version from GET). " +
              "Read-only fields (bucketName, table, status, bucketClass, metricInterval) are accepted but ignored by the API.",
          ),
      },
    },
    async ({ bucketName, bucket }) => {
      requireWrites(deps.config);
      // Extract version for required query parameter; fall back to undefined (API will reject)
      const version = typeof bucket["version"] === "number" ? (bucket["version"] as number) : undefined;
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/${encodeURIComponent(bucketName)}`,
          bucket,
          version !== undefined ? { "optimistic-locking-version": version } : {},
        ),
      );
    },
  );

  server.registerTool(
    "delete_grail_bucket",
    {
      description:
        "Delete a Grail retention bucket by name (WRITE, destructive, Dynatrace Storage Management v1). " +
        "This permanently removes all data in the bucket. The operation is asynchronous; " +
        "the bucket status transitions to 'deleting' until complete. " +
        "Cannot delete buckets whose name starts with 'default_' or 'dt_'. " +
        WRITE_NOTE,
      inputSchema: {
        bucketName: z.string().describe("The bucket name to delete."),
      },
    },
    async ({ bucketName }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${BASE}/${encodeURIComponent(bucketName)}`));
    },
  );
}

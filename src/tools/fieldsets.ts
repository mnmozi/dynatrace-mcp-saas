import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/storage/fieldsets/v1/fieldsets";

const WRITE_NOTE = "Requires DT_ENABLE_WRITES=true and the platform scope storage:fieldsets:write.";

const SCOPE = z
  .enum(["BUCKET", "TABLE", "TENANT"])
  .describe("Scope of the fieldset: BUCKET (specific buckets), TABLE (specific tables), or TENANT (whole tenant).");

export function registerFieldsetTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_fieldsets",
    {
      description:
        "List all Grail fieldsets (Storage Fieldsets v1). A fieldset is a curated, named list of field names " +
        "scoped to tables/buckets — useful as hints for which fields matter in a table (e.g. default columns, " +
        "sensitive-field groups). Note: fieldsets are curated presets, NOT a live catalog of the fields that " +
        "exist in a table — use describe_log_fields or a sampling DQL query for observed field discovery.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(BASE)),
  );

  server.registerTool(
    "get_fieldset",
    {
      description: "Get a single Grail fieldset by UID (Storage Fieldsets v1).",
      inputSchema: { fieldsetUid: z.string().describe("The fieldset UID to retrieve.") },
    },
    async ({ fieldsetUid }) => jsonResult(await deps.client.platform.get(`${BASE}/${encodeURIComponent(fieldsetUid)}`)),
  );

  server.registerTool(
    "create_fieldset",
    {
      description: "Create a new Grail fieldset (WRITE, Storage Fieldsets v1). " + WRITE_NOTE,
      inputSchema: {
        name: z.string().describe("Name of the fieldset."),
        fields: z.array(z.string()).max(100).describe("List of field names in the fieldset (max 100, unique)."),
        scope: SCOPE,
        tables: z
          .array(z.string())
          .max(30)
          .optional()
          .describe("Tables the fieldset applies to (for scope TABLE), e.g. ['logs']."),
        buckets: z
          .array(z.string())
          .max(100)
          .optional()
          .describe("Buckets the fieldset applies to (for scope BUCKET); supports trailing '*' wildcard."),
        description: z.string().max(512).optional().describe("Optional description."),
        enabled: z.boolean().optional().describe("Whether the fieldset is enabled (default true)."),
      },
    },
    async ({ name, fields, scope, tables, buckets, description, enabled }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(BASE, { name, fields, scope, tables, buckets, description, enabled }),
      );
    },
  );

  server.registerTool(
    "update_fieldset",
    {
      description:
        "Update a Grail fieldset by UID (WRITE, Storage Fieldsets v1). Full overwrite (PUT) with optimistic " +
        "locking — pass the current 'version' from get_fieldset. " +
        WRITE_NOTE,
      inputSchema: {
        fieldsetUid: z.string().describe("The fieldset UID to update."),
        version: z.number().int().describe("Current optimistic-locking version (from get_fieldset)."),
        fields: z.array(z.string()).max(100).describe("Full replacement list of field names."),
        scope: SCOPE,
        tables: z.array(z.string()).max(30).optional().describe("Tables the fieldset applies to."),
        buckets: z.array(z.string()).max(100).optional().describe("Buckets the fieldset applies to."),
        description: z.string().max(512).optional().describe("Optional description."),
        enabled: z.boolean().optional().describe("Whether the fieldset is enabled."),
      },
    },
    async ({ fieldsetUid, version, fields, scope, tables, buckets, description, enabled }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/${encodeURIComponent(fieldsetUid)}`,
          { fields, scope, tables, buckets, description, enabled },
          { "optimistic-locking-version": version },
        ),
      );
    },
  );

  server.registerTool(
    "delete_fieldset",
    {
      description: "Delete a Grail fieldset by UID (WRITE, Storage Fieldsets v1). " + WRITE_NOTE,
      inputSchema: { fieldsetUid: z.string().describe("The fieldset UID to delete.") },
    },
    async ({ fieldsetUid }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${BASE}/${encodeURIComponent(fieldsetUid)}`));
    },
  );
}

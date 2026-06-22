import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

export function registerSettingsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_settings_schemas",
    {
      description: "List Settings 2.0 schema ids (classic). These identify configurable settings types. Returns one page; pass nextPageKey to page through results.",
      inputSchema: {
        pageSize: z.number().int().positive().max(500).optional(),
        nextPageKey: z.string().optional().describe("Opaque next-page cursor from a previous response's nextPageKey; when set, other filters are ignored (classic API requirement)."),
      },
    },
    async ({ pageSize, nextPageKey }) =>
      jsonResult(await deps.client.classic.get("/api/v2/settings/schemas",
        nextPageKey ? { nextPageKey } : { pageSize: pageSize ?? 500 },
      )),
  );

  server.registerTool(
    "get_settings_schema",
    {
      description: "Get the full JSON schema for a Settings 2.0 schemaId. Use this to construct a valid 'value' before writing.",
      inputSchema: { schemaId: z.string().describe("e.g. 'builtin:tags' or 'builtin:anomaly-detection.services'.") },
    },
    async ({ schemaId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/settings/schemas/${encodeURIComponent(schemaId)}`)),
  );

  server.registerTool(
    "list_settings_objects",
    {
      description: "List Settings 2.0 objects, filtered by schema and/or scope. Returns one page; pass nextPageKey to page through results.",
      inputSchema: {
        schemaIds: z.string().optional().describe("Comma-separated schema ids."),
        scopes: z.string().optional().describe("Comma-separated scopes, e.g. 'environment' or a HOST-xxx id."),
        pageSize: z.number().int().positive().max(500).optional(),
        nextPageKey: z.string().optional().describe("Opaque next-page cursor from a previous response's nextPageKey; when set, other filters are ignored (classic API requirement)."),
      },
    },
    async ({ schemaIds, scopes, pageSize, nextPageKey }) =>
      jsonResult(await deps.client.classic.get("/api/v2/settings/objects",
        nextPageKey
          ? { nextPageKey }
          : { schemaIds, scopes, pageSize: pageSize ?? 100, fields: "objectId,value,scope,schemaId" },
      )),
  );

  server.registerTool(
    "get_settings_object",
    {
      description: "Get one Settings 2.0 object by objectId.",
      inputSchema: { objectId: z.string() },
    },
    async ({ objectId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`)),
  );

  server.registerTool(
    "validate_settings_object",
    {
      description: "Validate a Settings 2.0 object payload WITHOUT persisting it (validateOnly=true). Returns constraint violations if invalid. Always safe (read-only).",
      inputSchema: {
        schemaId: z.string(),
        scope: z.string().describe("e.g. 'environment' or an entity id."),
        value: z.record(z.unknown()).describe("The settings value object matching the schema."),
      },
    },
    async ({ schemaId, scope, value }) =>
      jsonResult(await deps.client.classic.post("/api/v2/settings/objects", [{ schemaId, scope, value }], { validateOnly: true })),
  );

  server.registerTool(
    "create_settings_object",
    {
      description: "Create a Settings 2.0 object (WRITE). Validate first with validate_settings_object.",
      inputSchema: { schemaId: z.string(), scope: z.string(), value: z.record(z.unknown()) },
    },
    async ({ schemaId, scope, value }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.post("/api/v2/settings/objects", [{ schemaId, scope, value }]));
    },
  );

  server.registerTool(
    "update_settings_object",
    {
      description: "Update an existing Settings 2.0 object by objectId (WRITE).",
      inputSchema: { objectId: z.string(), value: z.record(z.unknown()) },
    },
    async ({ objectId, value }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.put(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`, { value }));
    },
  );

  server.registerTool(
    "delete_settings_object",
    {
      description: "Delete a Settings 2.0 object by objectId (WRITE, destructive).",
      inputSchema: { objectId: z.string() },
    },
    async ({ objectId }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.del(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`));
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";
import { DynatraceApiError } from "../http/errors.js";
import type { HostClient } from "../types.js";

/** Discriminated result from a validateOnly call. */
type ValidationResult =
  | { valid: true }
  | { valid: false; violations: unknown };

/**
 * Run a Settings 2.0 validateOnly POST and return a discriminated result.
 * Returns { valid: true } on 200.
 * Returns { valid: false, violations } on 400 with constraintViolations.
 * Rethrows any other error.
 */
async function validateSettingsValue(
  client: HostClient,
  schemaId: string,
  scope: string,
  value: Record<string, unknown>,
): Promise<ValidationResult> {
  try {
    await client.post("/api/v2/settings/objects", [{ schemaId, scope, value }], { validateOnly: true });
    return { valid: true };
  } catch (err) {
    if (
      err instanceof DynatraceApiError &&
      err.status === 400 &&
      typeof err.body === "object" &&
      err.body !== null &&
      "error" in err.body &&
      typeof (err.body as Record<string, unknown>).error === "object" &&
      (err.body as Record<string, unknown>).error !== null &&
      "constraintViolations" in ((err.body as Record<string, unknown>).error as Record<string, unknown>)
    ) {
      const apiError = err.body as { error: { constraintViolations: unknown } };
      return { valid: false, violations: apiError.error.constraintViolations };
    }
    throw err;
  }
}

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
    async ({ schemaId, scope, value }) => {
      const result = await validateSettingsValue(deps.client.classic, schemaId, scope, value);
      if (!result.valid) {
        return jsonResult({ valid: false, violations: result.violations });
      }
      return jsonResult({ valid: true });
    },
  );

  server.registerTool(
    "create_settings_object",
    {
      description: "Create a Settings 2.0 object (WRITE). Validates against the live schema first (validateOnly); returns constraintViolations without creating if invalid. Pass dryRun:true to validate only.",
      inputSchema: {
        schemaId: z.string(),
        scope: z.string(),
        value: z.record(z.unknown()),
        dryRun: z.boolean().optional().describe("If true, only validate the object against the live schema (validateOnly) and return the result WITHOUT creating it. Does not require DT_ENABLE_WRITES."),
      },
    },
    async ({ schemaId, scope, value, dryRun }) => {
      // Step 1: validate against the live schema
      const validation = await validateSettingsValue(deps.client.classic, schemaId, scope, value);
      if (!validation.valid) {
        return jsonResult({ valid: false, violations: validation.violations });
      }

      // Step 2: if dryRun, return early without persisting
      if (dryRun) {
        return jsonResult({ valid: true, dryRun: true });
      }

      // Step 3: require writes before persisting
      requireWrites(deps.config);

      // Step 4: persist
      return jsonResult(await deps.client.classic.post("/api/v2/settings/objects", [{ schemaId, scope, value }]));
    },
  );

  server.registerTool(
    "update_settings_object",
    {
      description: "Update an existing Settings 2.0 object by objectId (WRITE). Validates against the live schema first (validateOnly); returns constraintViolations without updating if invalid. Pass dryRun:true to validate only.",
      inputSchema: {
        objectId: z.string(),
        value: z.record(z.unknown()),
        dryRun: z.boolean().optional().describe("If true, only validate the object against the live schema (validateOnly) and return the result WITHOUT updating it. Does not require DT_ENABLE_WRITES."),
      },
    },
    async ({ objectId, value, dryRun }) => {
      // Step 1: GET the existing object to learn schemaId + scope
      const existing = await deps.client.classic.get<{ schemaId: string; scope: string; value: Record<string, unknown> }>(
        `/api/v2/settings/objects/${encodeURIComponent(objectId)}`,
      );

      const { schemaId, scope } = existing;

      // Step 2: validate against the live schema
      const validation = await validateSettingsValue(deps.client.classic, schemaId, scope, value);
      if (!validation.valid) {
        return jsonResult({ valid: false, violations: validation.violations });
      }

      // Step 3: if dryRun, return early without persisting
      if (dryRun) {
        return jsonResult({ valid: true, dryRun: true });
      }

      // Step 4: require writes before persisting
      requireWrites(deps.config);

      // Step 5: persist via PUT
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

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";
import { containsIgnoreCase } from "../util/text-match.js";
import { DynatraceApiError } from "../http/errors.js";
import type { HostClient } from "../types.js";

/** Discriminated result from a validateOnly call. */
type ValidationResult = { valid: true } | { valid: false; violations: unknown[]; reason: string };

/**
 * Run a Settings 2.0 validateOnly request and return a discriminated result.
 * Returns { valid: true } on 200.
 * Returns { valid: false, violations, reason } on any 400: violations may be empty
 * (Dynatrace rejects some objects with only a message), reason is its own explanation.
 * Rethrows any other error.
 */
async function runSettingsValidation(request: () => Promise<unknown>): Promise<ValidationResult> {
  try {
    await request();
    return { valid: true };
  } catch (err) {
    if (err instanceof DynatraceApiError && err.status === 400) {
      return { valid: false, violations: err.detail.violations, reason: err.reason };
    }
    throw err;
  }
}

/** Validate a CREATE: validateOnly POST of a new object to the collection. */
function validateSettingsValue(
  client: HostClient,
  schemaId: string,
  scope: string,
  value: Record<string, unknown>,
): Promise<ValidationResult> {
  return runSettingsValidation(() =>
    client.post("/api/v2/settings/objects", [{ schemaId, scope, value }], { validateOnly: true }),
  );
}

/**
 * Validate an UPDATE: validateOnly PUT to the object itself. Schemas whose validator depends on
 * the object's identity (e.g. builtin:hyperscaler-authentication.connections.azure, which signs
 * with subject dt:connection-id/<objectId>) fail a create-validation, which has no objectId.
 */
function validateSettingsUpdate(
  client: HostClient,
  objectId: string,
  value: Record<string, unknown>,
): Promise<ValidationResult> {
  return runSettingsValidation(() =>
    client.put(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`, { value }, { validateOnly: true }),
  );
}

function invalidResult(validation: { violations: unknown[]; reason: string }) {
  return jsonResult({
    valid: false,
    violations: validation.violations,
    ...(validation.reason ? { reason: validation.reason } : {}),
  });
}

interface SchemaStub {
  schemaId?: string;
  displayName?: string;
}

interface SchemaList {
  items?: SchemaStub[];
  totalCount?: number;
}

/** The schemas endpoint has no server-side filter, so the query is applied to the response. */
function keepSchemasMatching(list: SchemaList, query: string) {
  const items = (list.items ?? []).filter(
    (schema) => containsIgnoreCase(schema.schemaId ?? "", query) || containsIgnoreCase(schema.displayName ?? "", query),
  );
  return { ...list, items, matchedCount: items.length };
}

export function registerSettingsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_settings_schemas",
    {
      description:
        "List Settings 2.0 schema ids (classic). These identify configurable settings types. A tenant has several " +
        "hundred: pass query to get only the ones you need (e.g. 'sampling', 'oneagent.features'). " +
        "Returns one page; pass nextPageKey to page through results.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Keep only schemas whose schemaId or displayName contains this text (case-insensitive substring). " +
              "The response then adds matchedCount; totalCount stays the tenant's total.",
          ),
        pageSize: z.number().int().positive().max(500).optional(),
        nextPageKey: z
          .string()
          .optional()
          .describe(
            "Opaque next-page cursor from a previous response's nextPageKey; when set, other filters are ignored (classic API requirement).",
          ),
      },
    },
    async ({ query, pageSize, nextPageKey }) => {
      const list = await deps.client.classic.get<SchemaList>(
        "/api/v2/settings/schemas",
        nextPageKey ? { nextPageKey } : { pageSize: pageSize ?? 500 },
      );
      return jsonResult(query ? keepSchemasMatching(list, query) : list);
    },
  );

  server.registerTool(
    "get_settings_schema",
    {
      description:
        "Get the full JSON schema for a Settings 2.0 schemaId. Use this to construct a valid 'value' before writing.",
      inputSchema: { schemaId: z.string().describe("e.g. 'builtin:tags' or 'builtin:anomaly-detection.services'.") },
    },
    async ({ schemaId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/settings/schemas/${encodeURIComponent(schemaId)}`)),
  );

  server.registerTool(
    "list_settings_objects",
    {
      description:
        "List Settings 2.0 objects, filtered by schema and/or scope. Returns one page; pass nextPageKey to page through results.",
      inputSchema: {
        schemaIds: z.string().optional().describe("Comma-separated schema ids."),
        scopes: z.string().optional().describe("Comma-separated scopes, e.g. 'environment' or a HOST-xxx id."),
        pageSize: z.number().int().positive().max(500).optional(),
        nextPageKey: z
          .string()
          .optional()
          .describe(
            "Opaque next-page cursor from a previous response's nextPageKey; when set, other filters are ignored (classic API requirement).",
          ),
      },
    },
    async ({ schemaIds, scopes, pageSize, nextPageKey }) =>
      jsonResult(
        await deps.client.classic.get(
          "/api/v2/settings/objects",
          nextPageKey
            ? { nextPageKey }
            : { schemaIds, scopes, pageSize: pageSize ?? 100, fields: "objectId,value,scope,schemaId" },
        ),
      ),
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
      description:
        "Validate a Settings 2.0 object payload WITHOUT persisting it (validateOnly=true). Returns constraint violations and Dynatrace's reason if invalid. Always safe (read-only).",
      inputSchema: {
        schemaId: z.string(),
        scope: z.string().describe("e.g. 'environment' or an entity id."),
        value: z.record(z.unknown()).describe("The settings value object matching the schema."),
      },
    },
    async ({ schemaId, scope, value }) => {
      const result = await validateSettingsValue(deps.client.classic, schemaId, scope, value);
      if (!result.valid) {
        return invalidResult(result);
      }
      return jsonResult({ valid: true });
    },
  );

  server.registerTool(
    "create_settings_object",
    {
      description:
        "Create a Settings 2.0 object (WRITE). Validates against the live schema first (validateOnly); returns violations + reason without creating if invalid. Pass dryRun:true to validate only.",
      inputSchema: {
        schemaId: z.string(),
        scope: z.string(),
        value: z.record(z.unknown()),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "If true, only validate the object against the live schema (validateOnly) and return the result WITHOUT creating it. Does not require DT_ENABLE_WRITES.",
          ),
      },
    },
    async ({ schemaId, scope, value, dryRun }) => {
      // Step 1: validate against the live schema
      const validation = await validateSettingsValue(deps.client.classic, schemaId, scope, value);
      if (!validation.valid) {
        return invalidResult(validation);
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
      description:
        "Update an existing Settings 2.0 object by objectId (WRITE). Validates against the live schema first (validateOnly); returns violations + reason without updating if invalid. Pass dryRun:true to validate only.",
      inputSchema: {
        objectId: z.string(),
        value: z.record(z.unknown()),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "If true, only validate the object against the live schema (validateOnly) and return the result WITHOUT updating it. Does not require DT_ENABLE_WRITES.",
          ),
      },
    },
    async ({ objectId, value, dryRun }) => {
      // Step 1: validate the update itself (validateOnly PUT to the object)
      const validation = await validateSettingsUpdate(deps.client.classic, objectId, value);
      if (!validation.valid) {
        return invalidResult(validation);
      }

      // Step 2: if dryRun, return early without persisting
      if (dryRun) {
        return jsonResult({ valid: true, dryRun: true });
      }

      // Step 3: require writes before persisting
      requireWrites(deps.config);

      // Step 4: persist via PUT
      return jsonResult(
        await deps.client.classic.put(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`, { value }),
      );
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

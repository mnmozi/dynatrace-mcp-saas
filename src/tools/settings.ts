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
 * Where a Settings 2.0 request goes. The same API is mounted twice: on the classic host
 * (Api-Token) and on the platform host under /platform/classic/environment-api (platform
 * token, which carries a user identity). Most schemas accept either. A few only validate
 * or persist with a user identity: Dynatrace answers an Api-Token request for them with
 * "Could not do validation as request was not done using oAuth".
 */
interface SettingsRoute {
  client: HostClient;
  /** Prefix in front of /settings/objects. */
  base: string;
  /** Named in results so a caller can see which host and credential was used. */
  via: "classic" | "platform";
}

/** Schemas known to need a user identity. Anything else is caught by the oAuth-violation fallback. */
const IDENTITY_BOUND_SCHEMAS: readonly string[] = ["builtin:davis.anomaly-detectors"];

function classicRoute(deps: ToolDeps): SettingsRoute {
  return { client: deps.client.classic, base: "/api/v2", via: "classic" };
}

function platformRoute(deps: ToolDeps): SettingsRoute {
  return { client: deps.client.platform, base: "/platform/classic/environment-api/v2", via: "platform" };
}

function canUsePlatform(deps: ToolDeps): boolean {
  return Boolean(deps.config.platformUrl && deps.config.platformToken);
}

/** An objectId is base64url and embeds its schemaId as plain text. */
function isIdentityBoundObjectId(objectId: string): boolean {
  const decoded = Buffer.from(objectId, "base64url").toString("latin1");
  return IDENTITY_BOUND_SCHEMAS.some((schemaId) => decoded.includes(schemaId));
}

function isIdentityBound(schemaId: string): boolean {
  return IDENTITY_BOUND_SCHEMAS.includes(schemaId);
}

function firstRoute(deps: ToolDeps, identityBound: boolean): SettingsRoute {
  return identityBound && canUsePlatform(deps) ? platformRoute(deps) : classicRoute(deps);
}

/** True when a classic validation failed only because the request carried no user identity. */
function failedForMissingIdentity(result: ValidationResult): boolean {
  if (result.valid) return false;
  return /not done using oauth/i.test(`${result.reason} ${JSON.stringify(result.violations)}`);
}

/**
 * Validate on the first route; when the classic host refuses for lack of a user identity and a
 * platform token is configured, validate again on the platform host. Returns the route that
 * produced the result, so the persist call uses the same one.
 */
async function validateWithIdentityFallback(
  deps: ToolDeps,
  route: SettingsRoute,
  validate: (route: SettingsRoute) => Promise<ValidationResult>,
): Promise<{ validation: ValidationResult; route: SettingsRoute }> {
  const validation = await validate(route);
  if (route.via === "classic" && canUsePlatform(deps) && failedForMissingIdentity(validation)) {
    const platform = platformRoute(deps);
    return { validation: await validate(platform), route: platform };
  }
  return { validation, route };
}

const PLATFORM_SETTINGS_SCOPES = "settings:objects:read and settings:objects:write";

const MISSING_PLATFORM_TOKEN_HINT =
  "This schema only accepts requests that carry a user identity, which the classic Api-Token does not. " +
  `Set DT_PLATFORM_URL and DT_PLATFORM_TOKEN (a platform token with the scopes ${PLATFORM_SETTINGS_SCOPES}); ` +
  "the settings tools then send it through the platform host.";

/**
 * Send one request on a route. A 401/403 from the platform host is rethrown naming the scopes
 * the platform token needs: the generic 403 text cannot know this request was a Settings write.
 */
async function send<T>(route: SettingsRoute, request: (route: SettingsRoute) => Promise<T>): Promise<T> {
  try {
    return await request(route);
  } catch (err) {
    const denied = err instanceof DynatraceApiError && (err.status === 401 || err.status === 403);
    if (route.via !== "platform" || !denied) throw err;
    throw new Error(
      `${err.message}. Settings objects of this schema go through the platform host: ` +
        `DT_PLATFORM_TOKEN needs the scopes ${PLATFORM_SETTINGS_SCOPES}, and its owner needs permission to write the schema.`,
      { cause: err },
    );
  }
}

/** Adds the platform-route note to a result; classic results stay exactly as before. */
function withRoute<T>(result: T, route: SettingsRoute): T | { via: string; result: T } {
  return route.via === "platform" ? { via: "platform host (platform token identity)", result } : result;
}

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
  route: SettingsRoute,
  schemaId: string,
  scope: string,
  value: Record<string, unknown>,
): Promise<ValidationResult> {
  return runSettingsValidation(() =>
    send(route, ({ client, base }) =>
      client.post(`${base}/settings/objects`, [{ schemaId, scope, value }], { validateOnly: true }),
    ),
  );
}

/**
 * Validate an UPDATE: validateOnly PUT to the object itself. Schemas whose validator depends on
 * the object's identity (e.g. builtin:hyperscaler-authentication.connections.azure, which signs
 * with subject dt:connection-id/<objectId>) fail a create-validation, which has no objectId.
 */
function validateSettingsUpdate(
  route: SettingsRoute,
  objectId: string,
  value: Record<string, unknown>,
): Promise<ValidationResult> {
  return runSettingsValidation(() =>
    send(route, ({ client, base }) =>
      client.put(`${base}/settings/objects/${encodeURIComponent(objectId)}`, { value }, { validateOnly: true }),
    ),
  );
}

type FailedValidation = Extract<ValidationResult, { valid: false }>;

/** `route` is the one that produced the failure: a classic identity refusal means no platform token was usable. */
function invalidResult(validation: FailedValidation, route: SettingsRoute) {
  const needsPlatformToken = route.via === "classic" && failedForMissingIdentity(validation);
  return jsonResult({
    valid: false,
    violations: validation.violations,
    ...(validation.reason ? { reason: validation.reason } : {}),
    ...(needsPlatformToken ? { hint: MISSING_PLATFORM_TOKEN_HINT } : {}),
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
      const { validation, route } = await validateWithIdentityFallback(
        deps,
        firstRoute(deps, isIdentityBound(schemaId)),
        (candidate) => validateSettingsValue(candidate, schemaId, scope, value),
      );
      if (!validation.valid) {
        return invalidResult(validation, route);
      }
      return jsonResult(withRoute({ valid: true }, route));
    },
  );

  server.registerTool(
    "create_settings_object",
    {
      description:
        "Create a Settings 2.0 object (WRITE). Validates against the live schema first (validateOnly); returns violations + reason without creating if invalid. Pass dryRun:true to validate only. " +
        "Schemas that need a user identity (builtin:davis.anomaly-detectors, the Gen3 metric alerts / anomaly detectors) are sent through the platform host with the platform token, which needs the settings:objects:read and settings:objects:write scopes; the result is then {via, result}. " +
        "Anomaly detector value (scope 'environment'): {enabled, title, description, source, executionSettings: {} (Dynatrace sets executionSettings.actor to the platform token's user), " +
        "analyzer: {name: 'dt.statistics.ui.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer', input: [{key, value}] with every value a STRING: query (a DQL timeseries, add by:{...} to alert per dimension), threshold, alertCondition (ABOVE|BELOW), violatingSamples, slidingWindow, dealertingSamples, alertOnMissingData}, " +
        "eventTemplate: {properties: [{key: 'event.type', value: 'CUSTOM_ALERT'}, {key: 'event.name', value: '<problem title>'}]}}. Other analyzers and their inputs: list_davis_analyzers / get_davis_analyzer_input_schema.",
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
      const { validation, route } = await validateWithIdentityFallback(
        deps,
        firstRoute(deps, isIdentityBound(schemaId)),
        (candidate) => validateSettingsValue(candidate, schemaId, scope, value),
      );
      if (!validation.valid) {
        return invalidResult(validation, route);
      }

      // Step 2: if dryRun, return early without persisting
      if (dryRun) {
        return jsonResult(withRoute({ valid: true, dryRun: true }, route));
      }

      // Step 3: require writes before persisting
      requireWrites(deps.config);

      // Step 4: persist on the route that validated
      return jsonResult(
        withRoute(
          await send(route, ({ client, base }) =>
            client.post(`${base}/settings/objects`, [{ schemaId, scope, value }]),
          ),
          route,
        ),
      );
    },
  );

  server.registerTool(
    "update_settings_object",
    {
      description:
        "Update an existing Settings 2.0 object by objectId (WRITE). Validates against the live schema first (validateOnly); returns violations + reason without updating if invalid. Pass dryRun:true to validate only. " +
        "value replaces the whole object. Anomaly detectors (builtin:davis.anomaly-detectors) go through the platform host, as in create_settings_object.",
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
      const { validation, route } = await validateWithIdentityFallback(
        deps,
        firstRoute(deps, isIdentityBoundObjectId(objectId)),
        (candidate) => validateSettingsUpdate(candidate, objectId, value),
      );
      if (!validation.valid) {
        return invalidResult(validation, route);
      }

      // Step 2: if dryRun, return early without persisting
      if (dryRun) {
        return jsonResult(withRoute({ valid: true, dryRun: true }, route));
      }

      // Step 3: require writes before persisting
      requireWrites(deps.config);

      // Step 4: persist via PUT on the route that validated
      return jsonResult(
        withRoute(
          await send(route, ({ client, base }) =>
            client.put(`${base}/settings/objects/${encodeURIComponent(objectId)}`, { value }),
          ),
          route,
        ),
      );
    },
  );

  server.registerTool(
    "delete_settings_object",
    {
      description:
        "Delete a Settings 2.0 object by objectId (WRITE, destructive). Anomaly detectors (builtin:davis.anomaly-detectors) go through the platform host, as in create_settings_object.",
      inputSchema: { objectId: z.string() },
    },
    async ({ objectId }) => {
      requireWrites(deps.config);
      const route = firstRoute(deps, isIdentityBoundObjectId(objectId));
      return jsonResult(
        withRoute(
          await send(route, ({ client, base }) =>
            client.del(`${base}/settings/objects/${encodeURIComponent(objectId)}`),
          ),
          route,
        ),
      );
    },
  );
}

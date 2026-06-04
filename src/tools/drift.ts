import { z } from "zod";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import YAML from "yaml";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import {
  diffStringSets,
  diffVersionMap,
  diffObjectKeyPaths,
  diffOperations,
} from "../util/diff.js";
import { DynatraceApiError } from "../http/errors.js";

const SPECS_DIR = fileURLToPath(new URL("../../specs/", import.meta.url));

/** Derive a committed filename stem from a platform OpenAPI URL.
 *  e.g. "/platform/slo/v1/openapi.yaml" → "platform_slo_v1"
 */
function urlToStem(url: string): string {
  return url
    .replace(/\/openapi\.(yaml|yml)$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function registerDriftTools(server: McpServer, deps: ToolDeps): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Tool 1: check_settings_schema_drift
  // ──────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "check_settings_schema_drift",
    {
      description:
        "Compare committed settings-schema versions against the live tenant. " +
        "Optionally perform a structural key-path diff for a specific schemaId.",
      inputSchema: {
        schemaId: z
          .string()
          .optional()
          .describe(
            "Optional: a specific schemaId to also structurally diff (properties/enums) " +
              "against a committed snapshot, if one exists.",
          ),
      },
    },
    async ({ schemaId }) => {
      // Read committed manifest
      const manifestText = await readFile(
        SPECS_DIR + "settings-schemas/manifest.json",
        "utf8",
      );
      const manifest = JSON.parse(manifestText) as {
        count: number;
        schemas: Record<string, { version: string; displayName: string }>;
      };

      const baseline: Record<string, string> = {};
      for (const [id, info] of Object.entries(manifest.schemas)) {
        baseline[id] = info.version;
      }

      // Pull live schemas
      const liveResp = await deps.client.classic.get<{
        items: Array<{ schemaId: string; latestSchemaVersion: string }>;
      }>("/api/v2/settings/schemas", { pageSize: 500, fields: "schemaId,latestSchemaVersion" });

      const current: Record<string, string> = {};
      for (const item of liveResp.items ?? []) {
        current[item.schemaId] = item.latestSchemaVersion;
      }

      const versionDrift = diffVersionMap(baseline, current);

      const result: Record<string, unknown> = {
        baselineCount: Object.keys(baseline).length,
        liveCount: Object.keys(current).length,
        versionDrift,
      };

      if (schemaId !== undefined) {
        // Pull live schema for structural diff
        const liveSchema = await deps.client.classic.get<Record<string, unknown>>(
          `/api/v2/settings/schemas/${encodeURIComponent(schemaId)}`,
        );

        // Build snapshot filename: replace non-alphanumerics with _
        const safe = schemaId.replace(/[^a-zA-Z0-9]/g, "_");
        const snapshotPath = SPECS_DIR + `settings-schemas/${safe}.json`;

        let structuralDiff: unknown;
        try {
          const snapshotText = await readFile(snapshotPath, "utf8");
          const snapshot = JSON.parse(snapshotText) as unknown;
          structuralDiff = diffObjectKeyPaths(snapshot, liveSchema);
        } catch {
          structuralDiff = {
            note: "no committed snapshot for this schemaId; only version drift is available. Run refresh-snapshots to capture one.",
          };
        }

        result["structuralDiff"] = structuralDiff;
      }

      return jsonResult(result);
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Tool 2: check_api_spec_drift
  // ──────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "check_api_spec_drift",
    {
      description:
        "Compare committed OpenAPI specs against the live tenant's catalog. " +
        "Without args: returns a catalog-level overview of added/removed specs. " +
        "With a spec stem (e.g. 'platform_slo_v1', 'environment-api-v2'): deep-diffs operations.",
      inputSchema: {
        spec: z
          .string()
          .optional()
          .describe(
            "Optional committed spec stem to deep-diff " +
              "(e.g. 'platform_slo_v1', 'environment-api-v2'). " +
              "Omit for a catalog-level overview of added/removed specs.",
          ),
      },
    },
    async ({ spec }) => {
      // Build live platform catalog
      const swaggerUi = await deps.client.platform.get<{
        urls: Array<{ name: string; url: string }>;
      }>("/platform/metadata/v1/swagger-ui.json");

      // Derive stems from live catalog
      const liveCatalogEntries = (swaggerUi.urls ?? []).filter((e) =>
        e.url.startsWith("/platform"),
      );
      const liveDerivedStems = liveCatalogEntries.map((e) => urlToStem(e.url));

      // List committed platform spec stems
      const committedPlatformFiles = await readdir(SPECS_DIR + "platform");
      const committedStems = committedPlatformFiles
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map((f) => f.replace(/\.(yaml|yml)$/, ""));

      if (spec === undefined) {
        // Catalog-level overview
        const platformDiff = diffStringSets(committedStems, liveDerivedStems);
        return jsonResult({
          platformDrift: platformDiff,
          classicNote:
            "Classic specs environment-api-v1 and environment-api-v2 are committed in specs/classic/. " +
            "Use spec='environment-api-v2' or spec='environment-api-v1' to deep-diff them.",
        });
      }

      // Deep-diff for a specific spec
      if (spec.startsWith("platform_")) {
        // Find matching live catalog entry
        const match = liveCatalogEntries.find((e) => urlToStem(e.url) === spec);
        if (!match) {
          return jsonResult({ error: `no live platform spec matches ${spec}` });
        }

        // Download live spec — client.get uses safeJson which falls back to text for non-JSON
        const raw = await deps.client.platform.get<unknown>(match.url);
        const liveSpec = typeof raw === "string" ? (YAML.parse(raw) as unknown) : raw;

        // Read committed spec
        const committedText = await readFile(
          SPECS_DIR + `platform/${spec}.yaml`,
          "utf8",
        );
        const committedSpec = YAML.parse(committedText) as unknown;

        return jsonResult({
          spec,
          operationDrift: diffOperations(
            committedSpec as { paths?: Record<string, unknown> },
            liveSpec as { paths?: Record<string, unknown> },
          ),
        });
      }

      if (spec === "environment-api-v2") {
        const liveSpec = await deps.client.classic.get<{ paths?: Record<string, unknown> }>(
          "/api/v2/spec3.json",
        );
        const committedText = await readFile(
          SPECS_DIR + "classic/environment-api-v2.json",
          "utf8",
        );
        const committedSpec = JSON.parse(committedText) as { paths?: Record<string, unknown> };
        return jsonResult({ spec, operationDrift: diffOperations(committedSpec, liveSpec) });
      }

      if (spec === "environment-api-v1") {
        const liveSpec = await deps.client.classic.get<{ paths?: Record<string, unknown> }>(
          "/api/v1/spec",
        );
        const committedText = await readFile(
          SPECS_DIR + "classic/environment-api-v1.json",
          "utf8",
        );
        const committedSpec = JSON.parse(committedText) as { paths?: Record<string, unknown> };
        return jsonResult({ spec, operationDrift: diffOperations(committedSpec, liveSpec) });
      }

      return jsonResult({ error: "unknown spec stem" });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Tool 3: validate_against_live_schema
  // ──────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "validate_against_live_schema",
    {
      description:
        "Validate a settings value against the live schema (read-only, validateOnly). " +
        "Returns violations, required-missing keys, and a corrected value filtered to known properties.",
      inputSchema: {
        schemaId: z.string(),
        scope: z
          .string()
          .optional()
          .describe("default 'environment'"),
        value: z.record(z.unknown()),
      },
    },
    async ({ schemaId, scope, value }) => {
      // Pull live schema for property knowledge
      const liveSchema = await deps.client.classic.get<{
        properties?: Record<string, unknown>;
        required?: string[];
      }>(`/api/v2/settings/schemas/${encodeURIComponent(schemaId)}`);

      // Validate via POST with validateOnly=true
      let valid: boolean;
      let violations: unknown;

      try {
        await deps.client.classic.post(
          "/api/v2/settings/objects",
          [{ schemaId, scope: scope ?? "environment", value }],
          { validateOnly: true },
        );
        valid = true;
        violations = [];
      } catch (err) {
        if (err instanceof DynatraceApiError) {
          valid = false;
          violations =
            (err.body as { error?: { constraintViolations?: unknown } } | null)?.error
              ?.constraintViolations ?? err.body;
        } else {
          throw err;
        }
      }

      // Compute corrected value — filter to keys known in liveSchema.properties
      let correctedValue: Record<string, unknown>;
      const schemaProperties = liveSchema?.properties;
      if (schemaProperties && typeof schemaProperties === "object") {
        correctedValue = Object.fromEntries(
          Object.entries(value).filter(([k]) => k in schemaProperties),
        );
      } else {
        correctedValue = value;
      }

      // Compute required-missing
      const requiredMissing = (liveSchema?.required ?? []).filter((k) => !(k in value));

      return jsonResult({ valid, violations, requiredMissing, correctedValue });
    },
  );
}

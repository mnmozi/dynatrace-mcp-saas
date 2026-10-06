import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { listAllSettingsObjects, type SettingsObject } from "../util/settings-objects.js";
import { containsIgnoreCase } from "../util/text-match.js";
import { settingsScopeSchema } from "../schemas/settings.js";

const FEATURES_SCHEMA_ID = "builtin:oneagent.features";
const DEFAULT_FEATURE_LIMIT = 100;
const MAX_FEATURE_LIMIT = 1000;

interface OneAgentFeature {
  key: string;
  objectId: string;
  [flag: string]: unknown;
}

export function registerOneAgentTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_oneagent_features",
    {
      description:
        "List OneAgent feature flags (Settings 2.0 schema builtin:oneagent.features) with their exact key, " +
        "enabled / instrumentation / forcible flags and objectId. Use it to find the exact feature name: the schema " +
        "takes its keys from a datasource it does not enumerate, so get_settings_schema cannot answer that. " +
        "It lists the features that have a settings object AT the given scope — at 'environment' that is the " +
        "tenant-wide list (several hundred); at a host or process group it is only the overrides set there. " +
        "Change a feature with update_settings_object using its objectId.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Keep only features whose key contains this text (case-insensitive), e.g. 'sampling' or 'JAVA'."),
        scope: settingsScopeSchema,
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_FEATURE_LIMIT)
          .optional()
          .describe(
            `Max features to return (default ${DEFAULT_FEATURE_LIMIT}). When more match, truncated is true: narrow query or raise limit.`,
          ),
      },
    },
    async ({ query, scope, limit }) => {
      const objects = await listAllSettingsObjects(deps.client.classic, { schemaIds: [FEATURES_SCHEMA_ID], scope });
      const matching = sortByKey(objects.map(toFeature)).filter(
        (feature) => !query || containsIgnoreCase(feature.key, query),
      );
      const features = matching.slice(0, limit ?? DEFAULT_FEATURE_LIMIT);
      return jsonResult({
        scope,
        totalCount: objects.length,
        matchedCount: matching.length,
        truncated: features.length < matching.length,
        features,
      });
    },
  );
}

function toFeature(object: SettingsObject): OneAgentFeature {
  return { ...object.value, key: String(object.value.key ?? ""), objectId: object.objectId };
}

function sortByKey(features: OneAgentFeature[]): OneAgentFeature[] {
  return [...features].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

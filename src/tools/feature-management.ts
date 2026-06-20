import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/feature-management/v0.1";

export function registerFeatureManagementTools(server: McpServer, deps: ToolDeps): void {
  // ── Projects ────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_feature_projects",
    {
      description:
        "List all Feature Management projects (Dynatrace Feature Management API). " +
        "Requires feature-management:projects:read scope.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(`${BASE}/projects`)),
  );

  server.registerTool(
    "get_feature_project",
    {
      description:
        "Get a Feature Management project by key (Dynatrace Feature Management API).",
      inputSchema: { projectKey: z.string().describe("The project key.") },
    },
    async ({ projectKey }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/projects/${encodeURIComponent(projectKey)}`,
        ),
      ),
  );

  server.registerTool(
    "create_feature_project",
    {
      description:
        "Create a Feature Management project (WRITE). " +
        "Requires feature-management:projects:write scope and DT_ENABLE_WRITES.",
      inputSchema: {
        project: z
          .record(z.unknown())
          .describe(
            "Project body per the Feature Management API spec (key, name, description, owner, maintainers).",
          ),
      },
    },
    async ({ project }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(`${BASE}/projects`, project));
    },
  );

  server.registerTool(
    "update_feature_project",
    {
      description:
        "Update a Feature Management project by key (WRITE). " +
        "Requires feature-management:projects:write scope and DT_ENABLE_WRITES.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        project: z
          .record(z.unknown())
          .describe(
            "Project update body (name, description, owner, maintainers, version).",
          ),
      },
    },
    async ({ projectKey, project }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/projects/${encodeURIComponent(projectKey)}`,
          project,
        ),
      );
    },
  );

  server.registerTool(
    "delete_feature_project",
    {
      description:
        "Delete a Feature Management project by key (WRITE, destructive). " +
        "Requires feature-management:projects:delete scope and DT_ENABLE_WRITES.",
      inputSchema: { projectKey: z.string().describe("The project key.") },
    },
    async ({ projectKey }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.del(
          `${BASE}/projects/${encodeURIComponent(projectKey)}`,
        ),
      );
    },
  );

  // ── Features ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_features",
    {
      description:
        "List all features in a Feature Management project. " +
        "Requires feature-management:features:read scope.",
      inputSchema: { projectKey: z.string().describe("The project key.") },
    },
    async ({ projectKey }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features`,
        ),
      ),
  );

  server.registerTool(
    "get_feature",
    {
      description:
        "Get a feature by key within a project (Dynatrace Feature Management API). " +
        "Requires feature-management:features:read scope.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
      },
    },
    async ({ projectKey, featureKey }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}`,
        ),
      ),
  );

  server.registerTool(
    "create_feature",
    {
      description:
        "Create a feature in a project (WRITE). " +
        "Requires feature-management:features:write scope and DT_ENABLE_WRITES.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        feature: z
          .record(z.unknown())
          .describe(
            "Feature body per the Feature Management API spec (key, name, variants, type, description, flags, owner, maintainers).",
          ),
      },
    },
    async ({ projectKey, feature }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features`,
          feature,
        ),
      );
    },
  );

  server.registerTool(
    "update_feature",
    {
      description:
        "Update a feature by key within a project (WRITE). " +
        "Requires feature-management:features:write scope and DT_ENABLE_WRITES.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
        feature: z
          .record(z.unknown())
          .describe(
            "Feature update body (name, description, type, variants, owner, maintainers, version, status).",
          ),
      },
    },
    async ({ projectKey, featureKey, feature }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}`,
          feature,
        ),
      );
    },
  );

  server.registerTool(
    "delete_feature",
    {
      description:
        "Delete a feature by key within a project (WRITE, destructive). " +
        "Requires feature-management:features:delete scope and DT_ENABLE_WRITES.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
      },
    },
    async ({ projectKey, featureKey }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.del(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}`,
        ),
      );
    },
  );

  // ── Flags ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_feature_flags",
    {
      description:
        "List all flags in a feature (Dynatrace Feature Management API). " +
        "Requires feature-management:features:read scope.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
      },
    },
    async ({ projectKey, featureKey }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}/flags`,
        ),
      ),
  );

  server.registerTool(
    "get_feature_flag",
    {
      description:
        "Get a feature flag by key (Dynatrace Feature Management API). " +
        "Requires feature-management:features:read scope.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
        flagKey: z.string().describe("The flag key."),
      },
    },
    async ({ projectKey, featureKey, flagKey }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}/flags/${encodeURIComponent(flagKey)}`,
        ),
      ),
  );

  server.registerTool(
    "create_feature_flag",
    {
      description:
        "Create a flag in a feature (WRITE). " +
        "Requires feature-management:features:write scope and DT_ENABLE_WRITES.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
        flag: z
          .record(z.unknown())
          .describe(
            "Flag body per the Feature Management API spec (key, name, type, variants, description, tags).",
          ),
      },
    },
    async ({ projectKey, featureKey, flag }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}/flags`,
          flag,
        ),
      );
    },
  );

  server.registerTool(
    "update_feature_flag",
    {
      description:
        "Update a feature flag by key (WRITE). " +
        "Requires feature-management:features:write scope and DT_ENABLE_WRITES.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
        flagKey: z.string().describe("The flag key."),
        flag: z
          .record(z.unknown())
          .describe(
            "Flag update body (name, description, tags, variants, version).",
          ),
      },
    },
    async ({ projectKey, featureKey, flagKey, flag }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}/flags/${encodeURIComponent(flagKey)}`,
          flag,
        ),
      );
    },
  );

  server.registerTool(
    "delete_feature_flag",
    {
      description:
        "Delete a feature flag by key (WRITE, destructive). " +
        "Requires feature-management:features:delete scope and DT_ENABLE_WRITES.",
      inputSchema: {
        projectKey: z.string().describe("The project key."),
        featureKey: z.string().describe("The feature key."),
        flagKey: z.string().describe("The flag key."),
      },
    },
    async ({ projectKey, featureKey, flagKey }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.del(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/features/${encodeURIComponent(featureKey)}/flags/${encodeURIComponent(flagKey)}`,
        ),
      );
    },
  );

  // ── Release Stages (read-only) ────────────────────────────────────────────

  server.registerTool(
    "list_release_stages",
    {
      description:
        "List all release stages in a Feature Management project. " +
        "Requires feature-management:projects:read scope.",
      inputSchema: { projectKey: z.string().describe("The project key.") },
    },
    async ({ projectKey }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/projects/${encodeURIComponent(projectKey)}/release-stages`,
        ),
      ),
  );
}

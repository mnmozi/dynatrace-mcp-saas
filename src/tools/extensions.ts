import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/extensions/v2/extensions";

export function registerExtensionsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_extensions",
    {
      description: "List all Extensions 2.0 available in the environment.",
      inputSchema: {
        pageSize: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ pageSize }) =>
      jsonResult(
        await deps.client.platform.get(BASE, {
          "page-size": pageSize ?? 20,
        }),
      ),
  );

  server.registerTool(
    "get_extension",
    {
      description: "List all versions of a specific Extension 2.0 by name.",
      inputSchema: {
        extensionName: z.string().describe("The extension name, e.g. 'com.dynatrace.extension.sql-server'."),
      },
    },
    async ({ extensionName }) =>
      jsonResult(
        await deps.client.platform.get(`${BASE}/${encodeURIComponent(extensionName)}`),
      ),
  );

  server.registerTool(
    "get_extension_environment_config",
    {
      description: "Get the environment-level configuration for an Extension 2.0.",
      inputSchema: {
        extensionName: z.string().describe("The extension name."),
      },
    },
    async ({ extensionName }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/${encodeURIComponent(extensionName)}/environment-configuration`,
        ),
      ),
  );

  server.registerTool(
    "list_extension_monitoring_configs",
    {
      description: "List all monitoring configurations for an Extension 2.0.",
      inputSchema: {
        extensionName: z.string().describe("The extension name."),
        pageSize: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ extensionName, pageSize }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/${encodeURIComponent(extensionName)}/monitoring-configurations`,
          { "page-size": pageSize ?? 20 },
        ),
      ),
  );

  server.registerTool(
    "get_extension_monitoring_config",
    {
      description: "Get details of a specific monitoring configuration for an Extension 2.0.",
      inputSchema: {
        extensionName: z.string().describe("The extension name."),
        configurationId: z.string().describe("The monitoring configuration ID."),
      },
    },
    async ({ extensionName, configurationId }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/${encodeURIComponent(extensionName)}/monitoring-configurations/${encodeURIComponent(configurationId)}`,
        ),
      ),
  );

  server.registerTool(
    "create_extension_monitoring_config",
    {
      description:
        "Create a new monitoring configuration for an Extension 2.0 (WRITE). " +
        "The config object must include at minimum a 'scope' field (e.g. HOST-XXXX) and a 'value' object.",
      inputSchema: {
        extensionName: z.string().describe("The extension name."),
        config: z
          .record(z.unknown())
          .describe("Monitoring configuration body. Must contain at least 'scope' and 'value'."),
      },
    },
    async ({ extensionName, config }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(
          `${BASE}/${encodeURIComponent(extensionName)}/monitoring-configurations`,
          config,
        ),
      );
    },
  );

  server.registerTool(
    "update_extension_monitoring_config",
    {
      description:
        "Update a specified monitoring configuration for an Extension 2.0 (WRITE). " +
        "Scope cannot be changed; only the 'value' field is updated.",
      inputSchema: {
        extensionName: z.string().describe("The extension name."),
        configurationId: z.string().describe("The monitoring configuration ID to update."),
        config: z
          .record(z.unknown())
          .describe("Update body. Typically contains a 'value' object."),
      },
    },
    async ({ extensionName, configurationId, config }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/${encodeURIComponent(extensionName)}/monitoring-configurations/${encodeURIComponent(configurationId)}`,
          config,
        ),
      );
    },
  );

  server.registerTool(
    "delete_extension_monitoring_config",
    {
      description: "Delete a specified monitoring configuration for an Extension 2.0 (WRITE, destructive).",
      inputSchema: {
        extensionName: z.string().describe("The extension name."),
        configurationId: z.string().describe("The monitoring configuration ID to delete."),
      },
    },
    async ({ extensionName, configurationId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.del(
          `${BASE}/${encodeURIComponent(extensionName)}/monitoring-configurations/${encodeURIComponent(configurationId)}`,
        ),
      );
    },
  );
}

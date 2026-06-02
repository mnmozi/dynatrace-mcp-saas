import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { escapeQuotes } from "../util/escape.js";

export function registerEntitiesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_hosts",
    {
      description: "List monitored hosts (classic Entities v2, entitySelector type(HOST)). Optional tag/management-zone filters.",
      inputSchema: {
        tag: z.string().optional().describe("Filter by tag, e.g. 'env:prod'."),
        managementZone: z.string().optional().describe("Filter by management zone name."),
        pageSize: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ tag, managementZone, pageSize }) => {
      let selector = "type(HOST)";
      if (tag) selector += `,tag("${escapeQuotes(tag)}")`;
      if (managementZone) selector += `,mzName("${escapeQuotes(managementZone)}")`;
      return jsonResult(await deps.client.classic.get("/api/v2/entities", {
        entitySelector: selector,
        pageSize: pageSize ?? 100,
        fields: "+properties.osType,+properties.monitoringMode,+tags",
      }));
    },
  );

  server.registerTool(
    "find_entities",
    {
      description: "Find monitored entities by entitySelector (services, process groups, applications, etc.).",
      inputSchema: {
        entitySelector: z.string().describe('entitySelector, e.g. type(SERVICE),entityName.contains("checkout").'),
        from: z.string().optional(),
        to: z.string().optional(),
        pageSize: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ entitySelector, from, to, pageSize }) =>
      jsonResult(await deps.client.classic.get("/api/v2/entities", {
        entitySelector, from, to, pageSize: pageSize ?? 100, fields: "+tags,+properties",
      })),
  );

  server.registerTool(
    "get_entity",
    {
      description: "Get details for one monitored entity by id, including properties and relationships.",
      inputSchema: { entityId: z.string().describe("Entity id, e.g. 'HOST-ABC123' or 'SERVICE-XYZ'.") },
    },
    async ({ entityId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/entities/${encodeURIComponent(entityId)}`, {
        fields: "+properties,+toRelationships,+fromRelationships,+tags",
      })),
  );

  server.registerTool(
    "list_entity_types",
    {
      description: "List available entity types (classic Entities v2).",
      inputSchema: { pageSize: z.number().int().positive().max(500).optional() },
    },
    async ({ pageSize }) =>
      jsonResult(await deps.client.classic.get("/api/v2/entityTypes", { pageSize: pageSize ?? 200 })),
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { escapeQuotes } from "../util/escape.js";

/** Map an entity id prefix (e.g. "HOST-ABC") or selector type (e.g. "HOST") to its Grail table. */
function entityTypeToTable(type: string): string {
  return `dt.entity.${type.toLowerCase().replace(/-/g, "_")}`;
}

export function registerEntitiesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_hosts",
    {
      description:
        "Queries Smartscape host entities via Grail DQL (Gen3-native). " +
        "Pass useClassic:true to use the classic Entities v2 API on Gen2 tenants. " +
        "Optional tag/management-zone filters only work with useClassic:true (Gen2).",
      inputSchema: {
        tag: z.string().optional().describe("Filter by tag, e.g. 'env:prod'. Only applied when useClassic:true."),
        managementZone: z.string().optional().describe("Filter by management zone name. Only applied when useClassic:true."),
        pageSize: z.number().int().positive().max(500).optional(),
        useClassic: z
          .boolean()
          .optional()
          .describe(
            "Use the classic Entities v2 API instead of Grail DQL (only for Gen2 tenants that still expose /api/v2/entities).",
          ),
      },
    },
    async ({ tag, managementZone, pageSize, useClassic }) => {
      if (useClassic) {
        let selector = "type(HOST)";
        if (tag) selector += `,tag("${escapeQuotes(tag)}")`;
        if (managementZone) selector += `,mzName("${escapeQuotes(managementZone)}")`;
        return jsonResult(await deps.client.classic.get("/api/v2/entities", {
          entitySelector: selector,
          pageSize: pageSize ?? 100,
          fields: "+properties.osType,+properties.monitoringMode,+tags",
        }));
      }

      // Default: Grail DQL
      const limit = pageSize ?? 100;
      const query = `fetch dt.entity.host | limit ${limit}`;
      const result = await deps.client.dqlExecute(query, { maxResultRecords: limit });
      const response: Record<string, unknown> = {
        source: "grail-dql",
        query,
        recordCount: result.records.length,
        records: result.records,
      };
      if (tag || managementZone) {
        response.note =
          "tag/managementZone filters are not applied in the Grail DQL path — pass useClassic:true to use them on a Gen2 tenant.";
      }
      return jsonResult(response);
    },
  );

  server.registerTool(
    "find_entities",
    {
      description:
        "Queries Smartscape entities via Grail DQL (Gen3-native). " +
        "Pass useClassic:true to use the classic Entities v2 API on Gen2 tenants. " +
        "The entitySelector must include a type(...) clause for the Grail DQL path; without it, a guidance message is returned.",
      inputSchema: {
        entitySelector: z.string().describe('entitySelector, e.g. type(SERVICE),entityName.contains("checkout").'),
        from: z.string().optional(),
        to: z.string().optional(),
        pageSize: z.number().int().positive().max(500).optional(),
        useClassic: z
          .boolean()
          .optional()
          .describe(
            "Use the classic Entities v2 API instead of Grail DQL (only for Gen2 tenants that still expose /api/v2/entities).",
          ),
      },
    },
    async ({ entitySelector, from, to, pageSize, useClassic }) => {
      if (useClassic) {
        return jsonResult(await deps.client.classic.get("/api/v2/entities", {
          entitySelector, from, to, pageSize: pageSize ?? 100, fields: "+tags,+properties",
        }));
      }

      // Default: Grail DQL — parse the entitySelector
      const typeMatch = /type\(\s*"?([A-Za-z0-9_-]+)"?\s*\)/i.exec(entitySelector);
      if (!typeMatch) {
        return jsonResult({
          unavailable: true,
          reason:
            "The selector has no type(...) clause to map to a Grail entity table. " +
            "Add a type(...) clause, or use execute_dql with a specific table, or pass useClassic:true on a Gen2 tenant.",
          useInstead: "execute_dql with: fetch dt.entity.<type> — or pass useClassic:true",
        });
      }
      const type = typeMatch[1];
      const table = entityTypeToTable(type);
      const limit = pageSize ?? 100;

      // Parse optional entityName.contains("x") or entityName("x")
      const nameMatch = /entityName(?:\.contains)?\(\s*"([^"]*)"\s*\)/i.exec(entitySelector);
      let query = `fetch ${table}`;
      if (nameMatch) {
        query += ` | filter contains(entity.name, "${escapeQuotes(nameMatch[1])}")`;
      }
      query += ` | limit ${limit}`;

      const result = await deps.client.dqlExecute(query, { maxResultRecords: limit });
      return jsonResult({
        source: "grail-dql",
        query,
        recordCount: result.records.length,
        records: result.records,
      });
    },
  );

  server.registerTool(
    "get_entity",
    {
      description:
        "Queries a single Smartscape entity by id via Grail DQL (Gen3-native). " +
        "Pass useClassic:true to use the classic Entities v2 API on Gen2 tenants.",
      inputSchema: {
        entityId: z.string().describe("Entity id, e.g. 'HOST-ABC123' or 'SERVICE-XYZ'."),
        useClassic: z
          .boolean()
          .optional()
          .describe(
            "Use the classic Entities v2 API instead of Grail DQL (only for Gen2 tenants that still expose /api/v2/entities).",
          ),
      },
    },
    async ({ entityId, useClassic }) => {
      if (useClassic) {
        return jsonResult(await deps.client.classic.get(`/api/v2/entities/${encodeURIComponent(entityId)}`, {
          fields: "+properties,+toRelationships,+fromRelationships,+tags",
        }));
      }

      // Default: Grail DQL — derive type from id prefix
      const type = entityId.slice(0, entityId.lastIndexOf("-"));
      const table = entityTypeToTable(type);
      const query = `fetch ${table} | filter id == "${escapeQuotes(entityId)}" | limit 1`;
      const result = await deps.client.dqlExecute(query, { maxResultRecords: 1 });
      return jsonResult({
        source: "grail-dql",
        query,
        record: result.records[0] ?? null,
      });
    },
  );

  server.registerTool(
    "list_entity_types",
    {
      description:
        "Queries Smartscape entity types via Grail DQL (Gen3-native). " +
        "Returns guidance on common Grail entity tables. " +
        "Pass useClassic:true to use the classic Entities v2 API on Gen2 tenants.",
      inputSchema: {
        pageSize: z.number().int().positive().max(500).optional(),
        useClassic: z
          .boolean()
          .optional()
          .describe(
            "Use the classic Entities v2 API instead of Grail DQL (only for Gen2 tenants that still expose /api/v2/entities).",
          ),
      },
    },
    async ({ pageSize, useClassic }) => {
      if (useClassic) {
        return jsonResult(await deps.client.classic.get("/api/v2/entityTypes", { pageSize: pageSize ?? 200 }));
      }

      // Default: return Grail entity table guidance
      return jsonResult({
        source: "grail-dql",
        note:
          "On Gen3/Grail tenants, entity types are queried directly from Grail tables. " +
          "Pass useClassic:true to retrieve entity types from the classic Entities v2 API on Gen2 tenants.",
        commonTables: [
          "dt.entity.host",
          "dt.entity.service",
          "dt.entity.process_group",
          "dt.entity.process_group_instance",
          "dt.entity.application",
          "dt.entity.synthetic_test",
          "dt.entity.kubernetes_cluster",
          "dt.entity.kubernetes_node",
          "dt.entity.cloud_application",
          "dt.entity.cloud_application_namespace",
          "dt.entity.custom_device",
          "dt.entity.database_service",
        ],
        usage: "Use execute_dql with any of these tables, e.g.: fetch dt.entity.host | limit 50",
        useClassicNote:
          "For a full list of entity types on a Gen2 tenant, call list_entity_types with useClassic:true.",
      });
    },
  );
}

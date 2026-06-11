import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { escapeQuotes } from "../util/escape.js";
import { DynatraceApiError } from "../http/errors.js";

/** Map an entity id prefix (e.g. "HOST-ABC") or selector type (e.g. "HOST") to its Grail table. */
function entityTypeToTable(type: string): string {
  return `dt.entity.${type.toLowerCase().replace(/-/g, "_")}`;
}

/** True when a DynatraceApiError status warrants a Grail DQL fallback. */
function isUnavailable(e: unknown): e is DynatraceApiError {
  return e instanceof DynatraceApiError && (e.status === 404 || e.status === 403);
}

export function registerEntitiesTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_hosts",
    {
      description:
        "List monitored hosts (classic Entities v2, entitySelector type(HOST)). Optional tag/management-zone filters. " +
        "On Gen3/Grail tenants where the classic Entities API is unavailable, automatically falls back to a Grail DQL query (fetch dt.entity.host).",
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
      try {
        return jsonResult(await deps.client.classic.get("/api/v2/entities", {
          entitySelector: selector,
          pageSize: pageSize ?? 100,
          fields: "+properties.osType,+properties.monitoringMode,+tags",
        }));
      } catch (e) {
        if (isUnavailable(e)) {
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
            response.note = "tag/managementZone filters are not applied in the Grail DQL fallback.";
          }
          return jsonResult(response);
        }
        throw e;
      }
    },
  );

  server.registerTool(
    "find_entities",
    {
      description:
        "Find monitored entities by entitySelector (services, process groups, applications, etc.). " +
        "On Gen3/Grail tenants where the classic Entities API is unavailable, automatically falls back to a Grail DQL query " +
        "by parsing the type(...) and entityName clauses from the selector.",
      inputSchema: {
        entitySelector: z.string().describe('entitySelector, e.g. type(SERVICE),entityName.contains("checkout").'),
        from: z.string().optional(),
        to: z.string().optional(),
        pageSize: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ entitySelector, from, to, pageSize }) => {
      try {
        return jsonResult(await deps.client.classic.get("/api/v2/entities", {
          entitySelector, from, to, pageSize: pageSize ?? 100, fields: "+tags,+properties",
        }));
      } catch (e) {
        if (isUnavailable(e)) {
          // Parse type(...) clause — required
          const typeMatch = /type\(\s*"?([A-Za-z0-9_-]+)"?\s*\)/i.exec(entitySelector);
          if (!typeMatch) {
            return jsonResult({
              unavailable: true,
              reason:
                "classic Entities API is unavailable on this tenant and the selector has no type(...) clause to map to a Grail table",
              useInstead: "execute_dql with: fetch dt.entity.<type>",
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
        }
        throw e;
      }
    },
  );

  server.registerTool(
    "get_entity",
    {
      description:
        "Get details for one monitored entity by id, including properties and relationships. " +
        "On Gen3/Grail tenants where the classic Entities API is unavailable, automatically falls back to a Grail DQL query " +
        "using the entity id to derive the entity table.",
      inputSchema: { entityId: z.string().describe("Entity id, e.g. 'HOST-ABC123' or 'SERVICE-XYZ'.") },
    },
    async ({ entityId }) => {
      try {
        return jsonResult(await deps.client.classic.get(`/api/v2/entities/${encodeURIComponent(entityId)}`, {
          fields: "+properties,+toRelationships,+fromRelationships,+tags",
        }));
      } catch (e) {
        if (isUnavailable(e)) {
          // Derive type: everything before the last "-" segment
          const type = entityId.slice(0, entityId.lastIndexOf("-"));
          const table = entityTypeToTable(type);
          const query = `fetch ${table} | filter id == "${escapeQuotes(entityId)}" | limit 1`;
          const result = await deps.client.dqlExecute(query, { maxResultRecords: 1 });
          return jsonResult({
            source: "grail-dql",
            query,
            record: result.records[0] ?? null,
          });
        }
        throw e;
      }
    },
  );

  server.registerTool(
    "list_entity_types",
    {
      description:
        "List available entity types (classic Entities v2). " +
        "On Gen3/Grail tenants where this endpoint is unavailable, returns guidance on how to query Grail entity tables directly.",
      inputSchema: { pageSize: z.number().int().positive().max(500).optional() },
    },
    async ({ pageSize }) => {
      try {
        return jsonResult(await deps.client.classic.get("/api/v2/entityTypes", { pageSize: pageSize ?? 200 }));
      } catch (e) {
        if (isUnavailable(e)) {
          return jsonResult({
            unavailable: true,
            reason: "The classic entityTypes API is not available on this Gen3 tenant.",
            useInstead:
              "Query Grail entity tables directly via execute_dql, e.g. 'fetch dt.entity.host', 'fetch dt.entity.service', " +
              "'fetch dt.entity.process_group', 'fetch dt.entity.process_group_instance', 'fetch dt.entity.kubernetes_cluster'.",
          });
        }
        throw e;
      }
    },
  );
}

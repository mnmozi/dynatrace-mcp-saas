import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { DynatraceApiError } from "../http/errors.js";

const SCHEMA_INCOMING = "builtin:bizevents.http.incoming";
const SCHEMA_OUTGOING = "builtin:bizevents.http.outgoing";

export function registerExtractionTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_bizevent_capture_rules",
    {
      description:
        "Summarize the bizevent HTTP capture rules (builtin:bizevents.http.incoming/outgoing): which request paths/methods trigger each event and which request/response fields are mapped into the bizevent. Read-only (classic Settings 2.0).",
      inputSchema: {
        direction: z
          .enum(["incoming", "outgoing", "both"])
          .optional()
          .describe("Which bizevent HTTP capture rules (default incoming)."),
        includeRaw: z
          .boolean()
          .optional()
          .describe("Include the raw settings value objects too."),
      },
    },
    async ({ direction, includeRaw }) => {
      const schemaIds =
        direction === "outgoing"
          ? [SCHEMA_OUTGOING]
          : direction === "both"
            ? [SCHEMA_INCOMING, SCHEMA_OUTGOING]
            : [SCHEMA_INCOMING];

      const summaries: unknown[] = [];
      const rawItems: unknown[] = [];

      for (const schemaId of schemaIds) {
        let items: Array<{ objectId: string; value: Record<string, unknown> }> = [];
        try {
          const resp = (await deps.client.classic.get("/api/v2/settings/objects", {
            schemaIds: schemaId,
            fields: "objectId,value",
            pageSize: 100,
          })) as { items: Array<{ objectId: string; value: Record<string, unknown> }> };
          items = resp.items ?? [];
        } catch (err) {
          if (err instanceof DynatraceApiError && (err.status === 403 || err.status === 404)) {
            summaries.push({ schemaId, unavailable: true, reason: err.message });
            continue;
          }
          throw err;
        }

        for (const item of items) {
          const v = item.value as Record<string, unknown>;
          const event = (v.event ?? {}) as Record<string, unknown>;
          const dataFields = (
            (event.data as Array<Record<string, unknown>> | undefined) ?? []
          ).map((d) => {
            const src = (d.source ?? {}) as Record<string, unknown>;
            return {
              name: d.name as string | undefined,
              sourceType: src.sourceType as string | undefined,
              source: src.source as string | undefined,
            };
          });

          const triggers = (
            (v.triggers as Array<Record<string, unknown>> | undefined) ?? []
          ).map((t) => {
            const src = (t.source ?? {}) as Record<string, unknown>;
            return {
              dataSource: src.dataSource as string | undefined,
              type: t.type as string | undefined,
              value: t.value as string | undefined,
              caseSensitive: t.caseSensitive as boolean | undefined,
            };
          });

          const providerObj = (event.provider ?? {}) as Record<string, unknown>;
          const typeObj = (event.type ?? {}) as Record<string, unknown>;
          const categoryObj = (event.category ?? {}) as Record<string, unknown>;

          summaries.push({
            schemaId,
            objectId: item.objectId,
            ruleName: v.ruleName as string | undefined,
            enabled: v.enabled as boolean | undefined,
            triggers,
            event: {
              provider: providerObj.source as string | undefined,
              type: typeObj.source as string | undefined,
              category: categoryObj.source as string | undefined,
            },
            fields: dataFields,
          });

          if (includeRaw) {
            rawItems.push({ schemaId, objectId: item.objectId, value: v });
          }
        }
      }

      return jsonResult({
        rules: summaries,
        ...(includeRaw ? { raw: rawItems } : {}),
      });
    },
  );

  server.registerTool(
    "describe_log_fields",
    {
      description:
        "Discover the JSON field names emitted in structured logs: samples logs (optionally filtered), parses the JSON `content` and returns the union of field names found + samples. Use the discovered fields to build extraction DQL with execute_dql. Read-only (Grail).",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe(
            "DQL filter expression to scope logs, e.g. 'k8s.container.name == \"api-gateway\"'.",
          ),
        from: z
          .string()
          .optional()
          .describe("DQL timeframe start, default 'now()-1h'."),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Sample size (default 100)."),
      },
    },
    async ({ filter, from, limit }) => {
      let q = `fetch logs, from:${from ?? "now()-1h"}`;
      if (filter) q += ` | filter ${filter}`;
      q += ` | filter isNotNull(content) and startsWith(content, "{") | parse content, "JSON:parsed" | fieldsKeep parsed | limit ${limit ?? 100}`;

      const result = await deps.client.dqlExecute(q, { maxResultRecords: limit ?? 100 });

      const fieldSet = new Set<string>();
      for (const r of result.records) {
        const p = r["parsed"];
        if (p && typeof p === "object") {
          for (const k of Object.keys(p as object)) {
            fieldSet.add(k);
          }
        }
      }

      return jsonResult({
        query: q,
        sampled: result.records.length,
        discoveredFields: [...fieldSet].sort(),
        samples: result.records.slice(0, 3),
      });
    },
  );
}

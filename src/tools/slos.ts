import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const SLO = "/platform/slo/v1/slos";

export function registerSloTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_slos",
    {
      description: "List Service-Level Objectives (platform SLO v1).",
      inputSchema: { pageSize: z.number().int().positive().max(500).optional() },
    },
    async ({ pageSize }) =>
      jsonResult(await deps.client.platform.get(SLO, { "page-size": pageSize ?? 100 })),
  );

  server.registerTool(
    "get_slo",
    {
      description: "Get one SLO by id (platform SLO v1).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      jsonResult(await deps.client.platform.get(`${SLO}/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "evaluate_slo",
    {
      description: "Get the current evaluation/error-budget for SLOs (platform SLO v1).",
      inputSchema: { from: z.string().optional(), to: z.string().optional() },
    },
    async ({ from, to }) =>
      jsonResult(await deps.client.platform.get(`${SLO}/evaluation`, { from, to })),
  );

  server.registerTool(
    "list_objective_templates",
    {
      description: "List SLO objective templates (platform SLO v1).",
      inputSchema: {},
    },
    async () =>
      jsonResult(await deps.client.platform.get("/platform/slo/v1/objective-templates")),
  );

  server.registerTool(
    "create_slo",
    {
      description: "Create an SLO (WRITE). Body fields per the SLO v1 spec (name, criteria, target, etc.).",
      inputSchema: { slo: z.record(z.unknown()).describe("SLO definition object matching platform SLO v1.") },
    },
    async ({ slo }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(SLO, slo));
    },
  );

  server.registerTool(
    "update_slo",
    {
      description: "Update an SLO by id (WRITE).",
      inputSchema: { id: z.string(), slo: z.record(z.unknown()) },
    },
    async ({ id, slo }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.put(`${SLO}/${encodeURIComponent(id)}`, slo));
    },
  );

  server.registerTool(
    "delete_slo",
    {
      description: "Delete an SLO by id (WRITE, destructive).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${SLO}/${encodeURIComponent(id)}`));
    },
  );
}

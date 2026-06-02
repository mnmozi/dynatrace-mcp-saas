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
      description:
        "Evaluate an SLO by ID and return its compliance result (platform SLO v1). " +
        "Uses the async evaluation:start / evaluation:poll flow per spec.",
      inputSchema: {
        id: z.string().describe("The SLO ID to evaluate."),
        timeframeFrom: z
          .string()
          .optional()
          .describe("Start of the custom timeframe, e.g. 'now-7d' or an ISO 8601 timestamp."),
        timeframeTo: z
          .string()
          .optional()
          .describe("End of the custom timeframe (defaults to 'now' when omitted)."),
      },
    },
    async ({ id, timeframeFrom, timeframeTo }) => {
      const body: Record<string, unknown> = { id };
      if (timeframeFrom !== undefined) {
        body.customTimeframe = { timeframeFrom, ...(timeframeTo !== undefined ? { timeframeTo } : {}) };
      }

      interface SloEvalResp {
        evaluationToken?: string;
        evaluationResults?: unknown;
        definition?: unknown;
        metadata?: unknown;
      }

      // POST evaluation:start — may return 200 (done) or 202 (async, has evaluationToken)
      const start = await deps.client.platform.post<SloEvalResp>(
        `${SLO}/evaluation:start`,
        body,
        { "request-timeout-milliseconds": 5000 },
      );

      if (!start.evaluationToken) {
        // 200 — result is inline
        return jsonResult(start);
      }

      const token = start.evaluationToken;
      const maxPolls = 60;
      const pollIntervalMs = 1000;

      for (let i = 0; i < maxPolls; i++) {
        await sleep(pollIntervalMs);
        const poll = await deps.client.platform.get<SloEvalResp>(
          `${SLO}/evaluation:poll`,
          { "evaluation-token": token, "request-timeout-milliseconds": 5000 },
        );
        if (!poll.evaluationToken) {
          // 200 — evaluation complete
          return jsonResult(poll);
        }
      }

      throw new Error(`SLO evaluation did not complete after ${maxPolls} polls`);
    },
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

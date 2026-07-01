import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";
import { workflowSchema } from "../schemas/automation.js";
import type { QueryParams } from "../types.js";

const BASE = "/platform/automation/v1";
const WF = `${BASE}/workflows`;
const EX = `${BASE}/executions`;

export function registerAutomationTools(server: McpServer, deps: ToolDeps): void {
  // ── READ-ONLY ──────────────────────────────────────────────────────────────

  server.registerTool(
    "list_workflows",
    {
      description:
        "List Dynatrace Automation (Workflows) workflows via the platform Automation v1 API. " +
        "Requires automation:workflows:read scope on the platform token.",
      inputSchema: {
        limit: z.number().int().positive().optional().describe("Number of results per page (default: server default)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
        search: z.string().optional().describe("Free-text search term to filter workflows by title."),
      },
    },
    async ({ limit, offset, search }) => {
      const params: QueryParams = {};
      if (limit !== undefined) params["limit"] = limit;
      if (offset !== undefined) params["offset"] = offset;
      if (search !== undefined) params["search"] = search;
      return jsonResult(await deps.client.platform.get(WF, params));
    },
  );

  server.registerTool(
    "get_workflow",
    {
      description:
        "Get a single Dynatrace Automation workflow by ID (platform Automation v1). " +
        "Requires automation:workflows:read scope.",
      inputSchema: {
        id: z.string().describe("UUID of the workflow to retrieve."),
      },
    },
    async ({ id }) => jsonResult(await deps.client.platform.get(`${WF}/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "list_workflow_executions",
    {
      description:
        "List Dynatrace Automation workflow executions (platform Automation v1). " +
        "Draft and simple workflow executions are not included. " +
        "Requires automation:workflows:read scope on the platform token.",
      inputSchema: {
        workflow: z
          .string()
          .optional()
          .describe(
            "Workflow UUID to filter executions. " +
              "Comma-separated UUIDs are accepted by the spec (multiple values).",
          ),
        state: z.string().optional().describe("Execution state filter. Comma-separated values, e.g. 'SUCCESS,FAILED'."),
        limit: z.number().int().positive().optional().describe("Number of results per page."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
      },
    },
    async ({ workflow, state, limit, offset }) => {
      const params: QueryParams = {};
      if (workflow !== undefined) params["workflow"] = workflow;
      if (state !== undefined) params["state"] = state;
      if (limit !== undefined) params["limit"] = limit;
      if (offset !== undefined) params["offset"] = offset;
      return jsonResult(await deps.client.platform.get(EX, params));
    },
  );

  server.registerTool(
    "get_workflow_execution",
    {
      description:
        "Get a single Dynatrace Automation workflow execution by ID (platform Automation v1). " +
        "Requires automation:workflows:read scope.",
      inputSchema: {
        id: z.string().describe("UUID of the execution to retrieve."),
      },
    },
    async ({ id }) => jsonResult(await deps.client.platform.get(`${EX}/${encodeURIComponent(id)}`)),
  );

  // ── WRITE-GATED ────────────────────────────────────────────────────────────

  server.registerTool(
    "create_workflow",
    {
      description:
        "Create a Dynatrace Automation workflow (WRITE, platform Automation v1). " +
        "Requires DT_ENABLE_WRITES=true and automation:workflows:write scope on the platform token.",
      inputSchema: {
        workflow: workflowSchema.describe("Workflow definition per the AutomationEngine v1 spec."),
      },
    },
    async ({ workflow }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(WF, workflow));
    },
  );

  server.registerTool(
    "update_workflow",
    {
      description:
        "Update (replace) a Dynatrace Automation workflow by ID (WRITE, platform Automation v1). " +
        "Requires DT_ENABLE_WRITES=true and automation:workflows:write scope on the platform token.",
      inputSchema: {
        id: z.string().describe("UUID of the workflow to update."),
        workflow: workflowSchema.describe("Full workflow definition to replace the existing one."),
      },
    },
    async ({ id, workflow }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.put(`${WF}/${encodeURIComponent(id)}`, workflow));
    },
  );

  server.registerTool(
    "delete_workflow",
    {
      description:
        "Delete a Dynatrace Automation workflow by ID (WRITE, destructive, platform Automation v1). " +
        "Requires DT_ENABLE_WRITES=true and automation:workflows:write scope on the platform token.",
      inputSchema: {
        id: z.string().describe("UUID of the workflow to delete."),
      },
    },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${WF}/${encodeURIComponent(id)}`));
    },
  );

  server.registerTool(
    "run_workflow",
    {
      description:
        "Trigger a run of a Dynatrace Automation workflow (WRITE, platform Automation v1). " +
        "Creates a new Execution for the workflow. " +
        "Requires DT_ENABLE_WRITES=true and automation:workflows:run scope on the platform token.",
      inputSchema: {
        id: z.string().describe("UUID of the workflow to run."),
        input: z
          .record(z.unknown())
          .optional()
          .describe(
            "Optional run input payload passed to the workflow as `input` (per ExecutionInputsRequest spec). " +
              "Defaults to {} if omitted.",
          ),
      },
    },
    async ({ id, input }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(`${WF}/${encodeURIComponent(id)}/run`, {
          input: input ?? {},
        }),
      );
    },
  );
}

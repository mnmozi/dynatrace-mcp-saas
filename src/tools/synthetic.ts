import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/synthetic/v1";
const MONITORS = `${BASE}/monitors`;
const LOCATIONS = `${BASE}/locations`;
const NODES = `${BASE}/nodes`;

export function registerSyntheticTools(server: McpServer, deps: ToolDeps): void {
  // ── Read-only ────────────────────────────────────────────────────────────

  server.registerTool(
    "list_monitors",
    {
      description:
        "List all synthetic monitors (browser and network availability). " +
        "Optionally filter using a monitor-selector expression.",
      inputSchema: {
        monitorSelector: z
          .string()
          .optional()
          .describe(
            "Optional filter selector, e.g. 'type(BROWSER)', 'enabled(true)', " +
              "'tag(env:prod)', or comma-separated combinations.",
          ),
      },
    },
    async ({ monitorSelector }) => {
      const params: Record<string, string> = {};
      if (monitorSelector !== undefined) params["monitor-selector"] = monitorSelector;
      return jsonResult(await deps.client.platform.get(MONITORS, params));
    },
  );

  server.registerTool(
    "get_monitor",
    {
      description: "Get the full definition of a single synthetic monitor by its entity ID.",
      inputSchema: { id: z.string().describe("Synthetic monitor entity ID, e.g. 'SYNTHETIC_TEST-1234'.") },
    },
    async ({ id }) =>
      jsonResult(await deps.client.platform.get(`${MONITORS}/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "list_synthetic_locations",
    {
      description:
        "List all synthetic locations (both public and private) available for the environment.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(LOCATIONS)),
  );

  server.registerTool(
    "list_synthetic_nodes",
    {
      description: "List all synthetic nodes (ActiveGates capable of running synthetic monitors).",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(NODES)),
  );

  // ── Write-gated ──────────────────────────────────────────────────────────

  server.registerTool(
    "create_monitor",
    {
      description:
        "Create a new synthetic monitor definition (WRITE). " +
        "Pass a full monitor body per the platform synthetic v1 spec " +
        "(SyntheticMultiProtocolMonitorRequest or SyntheticBrowserMonitorRequest).",
      inputSchema: {
        monitor: z
          .record(z.unknown())
          .describe("Monitor definition object matching platform synthetic v1."),
      },
    },
    async ({ monitor }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(MONITORS, monitor));
    },
  );

  server.registerTool(
    "update_monitor",
    {
      description:
        "Update (replace) a synthetic monitor definition by entity ID (WRITE). " +
        "Sends a full PUT to /monitors/{monitor-id} per the platform synthetic v1 spec.",
      inputSchema: {
        id: z.string().describe("Synthetic monitor entity ID."),
        monitor: z
          .record(z.unknown())
          .describe("Updated monitor definition object matching platform synthetic v1."),
      },
    },
    async ({ id, monitor }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(`${MONITORS}/${encodeURIComponent(id)}`, monitor),
      );
    },
  );

  server.registerTool(
    "delete_monitor",
    {
      description: "Delete a synthetic monitor definition by entity ID (WRITE, destructive).",
      inputSchema: { id: z.string().describe("Synthetic monitor entity ID to delete.") },
    },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.del(`${MONITORS}/${encodeURIComponent(id)}`),
      );
    },
  );
}

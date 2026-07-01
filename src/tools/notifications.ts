import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const V1 = "/platform/notification/v1";
const V2 = "/platform/notification/v2";

const notificationBody = z
  .record(z.unknown())
  .describe("Notification definition object. Pass all required fields per the notification spec.");

export function registerNotificationTools(server: McpServer, deps: ToolDeps): void {
  // ── Self-notifications (v1) ───────────────────────────────────────────────

  server.registerTool(
    "list_self_notifications",
    {
      description: "List self-notifications (platform notification v1). Returns paginated results array.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(`${V1}/self-notifications`)),
  );

  server.registerTool(
    "get_self_notification",
    {
      description: "Get a single self-notification by ID (platform notification v1).",
      inputSchema: { id: z.string().describe("Self-notification UUID.") },
    },
    async ({ id }) => jsonResult(await deps.client.platform.get(`${V1}/self-notifications/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "create_self_notification",
    {
      description: "Create a self-notification (WRITE, platform notification v1).",
      inputSchema: { notification: notificationBody },
    },
    async ({ notification }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(`${V1}/self-notifications`, notification));
    },
  );

  server.registerTool(
    "update_self_notification",
    {
      description: "Update a self-notification by ID (WRITE, platform notification v1).",
      inputSchema: {
        id: z.string().describe("Self-notification UUID."),
        notification: notificationBody,
      },
    },
    async ({ id, notification }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(`${V1}/self-notifications/${encodeURIComponent(id)}`, notification),
      );
    },
  );

  server.registerTool(
    "delete_self_notification",
    {
      description: "Delete a self-notification by ID (WRITE, destructive, platform notification v1).",
      inputSchema: { id: z.string().describe("Self-notification UUID.") },
    },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${V1}/self-notifications/${encodeURIComponent(id)}`));
    },
  );

  // ── Event-notifications (v2) ──────────────────────────────────────────────

  server.registerTool(
    "list_event_notifications",
    {
      description: "List event-notifications (platform notification v2). Returns paginated results array.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(`${V2}/event-notifications`)),
  );

  server.registerTool(
    "get_event_notification",
    {
      description: "Get a single event-notification by ID (platform notification v2).",
      inputSchema: { id: z.string().describe("Event-notification UUID.") },
    },
    async ({ id }) => jsonResult(await deps.client.platform.get(`${V2}/event-notifications/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "create_event_notification",
    {
      description: "Create an event-notification (WRITE, platform notification v2).",
      inputSchema: { notification: notificationBody },
    },
    async ({ notification }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(`${V2}/event-notifications`, notification));
    },
  );

  server.registerTool(
    "update_event_notification",
    {
      description: "Update an event-notification by ID (WRITE, platform notification v2).",
      inputSchema: {
        id: z.string().describe("Event-notification UUID."),
        notification: notificationBody,
      },
    },
    async ({ id, notification }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(`${V2}/event-notifications/${encodeURIComponent(id)}`, notification),
      );
    },
  );

  server.registerTool(
    "delete_event_notification",
    {
      description: "Delete an event-notification by ID (WRITE, destructive, platform notification v2).",
      inputSchema: { id: z.string().describe("Event-notification UUID.") },
    },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${V2}/event-notifications/${encodeURIComponent(id)}`));
    },
  );
}

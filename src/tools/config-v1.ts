import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const REQUEST_ATTRIBUTES = "/api/config/v1/service/requestAttributes";
const REQUEST_NAMING = "/api/config/v1/service/requestNaming";
const CUSTOM_SERVICES = "/api/config/v1/service/customServices";

const TECHNOLOGY_ENUM = z.enum(["java", "dotnet", "php", "nodejs", "go", "opentracing"]);

export function registerConfigV1Tools(server: McpServer, deps: ToolDeps): void {
  // ── Request Attributes ─────────────────────────────────────────────────────

  server.registerTool(
    "list_request_attributes",
    {
      description: "List all request attribute definitions (classic Config API v1).",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.classic.get(REQUEST_ATTRIBUTES)),
  );

  server.registerTool(
    "get_request_attribute",
    {
      description: "Get a single request attribute definition by ID (classic Config API v1).",
      inputSchema: { id: z.string().describe("Request attribute ID.") },
    },
    async ({ id }) =>
      jsonResult(await deps.client.classic.get(`${REQUEST_ATTRIBUTES}/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "create_request_attribute",
    {
      description:
        "Create a new request attribute (WRITE, classic Config API v1). " +
        "Body must include at minimum: name, dataType, dataSources.",
      inputSchema: {
        requestAttribute: z
          .record(z.unknown())
          .describe("Request attribute definition (name, dataType, dataSources, etc.)."),
      },
    },
    async ({ requestAttribute }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.post(REQUEST_ATTRIBUTES, requestAttribute));
    },
  );

  server.registerTool(
    "update_request_attribute",
    {
      description: "Update an existing request attribute by ID (WRITE, classic Config API v1).",
      inputSchema: {
        id: z.string().describe("Request attribute ID to update."),
        requestAttribute: z
          .record(z.unknown())
          .describe("Updated request attribute definition."),
      },
    },
    async ({ id, requestAttribute }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.classic.put(
          `${REQUEST_ATTRIBUTES}/${encodeURIComponent(id)}`,
          requestAttribute,
        ),
      );
    },
  );

  server.registerTool(
    "delete_request_attribute",
    {
      description: "Delete a request attribute by ID (WRITE, destructive, classic Config API v1).",
      inputSchema: { id: z.string().describe("Request attribute ID to delete.") },
    },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.classic.del(`${REQUEST_ATTRIBUTES}/${encodeURIComponent(id)}`),
      );
    },
  );

  // ── Request Naming Rules ────────────────────────────────────────────────────

  server.registerTool(
    "list_request_namings",
    {
      description: "List all request naming rules (classic Config API v1).",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.classic.get(REQUEST_NAMING)),
  );

  server.registerTool(
    "get_request_naming",
    {
      description: "Get a single request naming rule by ID (classic Config API v1).",
      inputSchema: { id: z.string().describe("Request naming rule ID.") },
    },
    async ({ id }) =>
      jsonResult(await deps.client.classic.get(`${REQUEST_NAMING}/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "create_request_naming",
    {
      description:
        "Create a new request naming rule (WRITE, classic Config API v1). " +
        "Body must include at minimum: naming, enabled, namingPattern, conditions.",
      inputSchema: {
        requestNaming: z
          .record(z.unknown())
          .describe("Request naming rule definition (naming, enabled, namingPattern, conditions, etc.)."),
      },
    },
    async ({ requestNaming }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.post(REQUEST_NAMING, requestNaming));
    },
  );

  server.registerTool(
    "update_request_naming",
    {
      description: "Update an existing request naming rule by ID (WRITE, classic Config API v1).",
      inputSchema: {
        id: z.string().describe("Request naming rule ID to update."),
        requestNaming: z
          .record(z.unknown())
          .describe("Updated request naming rule definition."),
      },
    },
    async ({ id, requestNaming }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.classic.put(
          `${REQUEST_NAMING}/${encodeURIComponent(id)}`,
          requestNaming,
        ),
      );
    },
  );

  server.registerTool(
    "delete_request_naming",
    {
      description: "Delete a request naming rule by ID (WRITE, destructive, classic Config API v1).",
      inputSchema: { id: z.string().describe("Request naming rule ID to delete.") },
    },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.classic.del(`${REQUEST_NAMING}/${encodeURIComponent(id)}`),
      );
    },
  );

  // ── Custom Services (read-only) ─────────────────────────────────────────────

  server.registerTool(
    "list_custom_services",
    {
      description:
        "List all custom service definitions for a given technology (classic Config API v1, read-only).",
      inputSchema: {
        technology: TECHNOLOGY_ENUM.describe(
          "Technology to list custom services for.",
        ),
      },
    },
    async ({ technology }) =>
      jsonResult(
        await deps.client.classic.get(`${CUSTOM_SERVICES}/${encodeURIComponent(technology)}`),
      ),
  );

  server.registerTool(
    "get_custom_service",
    {
      description:
        "Get a single custom service definition by technology and ID (classic Config API v1, read-only).",
      inputSchema: {
        technology: TECHNOLOGY_ENUM.describe("Technology the custom service belongs to."),
        id: z.string().describe("Custom service ID."),
      },
    },
    async ({ technology, id }) =>
      jsonResult(
        await deps.client.classic.get(
          `${CUSTOM_SERVICES}/${encodeURIComponent(technology)}/${encodeURIComponent(id)}`,
        ),
      ),
  );
}

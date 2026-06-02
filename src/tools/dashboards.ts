/**
 * Dashboard tools — backed by Dynatrace Document Service v1
 * (platform/document/v1).
 *
 * Spec: specs/platform/platform_document_v1.yaml
 *
 * Key decisions grounded in the spec:
 *  - CREATE and UPDATE require multipart/form-data (spec: requestBody content
 *    type is multipart/form-data for POST /documents and PATCH /documents/{id}).
 *    The `content` part must be a binary blob; we serialize the JS object to
 *    JSON and attach it with Content-Type application/json per the spec rule
 *    "Its exact type is taken from the Content-Type header".
 *  - GET uses /documents/{id}/metadata (JSON) + /documents/{id}/content
 *    (raw bytes), rather than /documents/{id} which returns a raw multipart
 *    response that would require a multipart parser.
 *  - DELETE and UPDATE both require `optimistic-locking-version` as a query
 *    param (required: true per spec).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const DOC_BASE = "/platform/document/v1/documents";

export function registerDashboardTools(server: McpServer, deps: ToolDeps): void {
  // ── list_dashboards ───────────────────────────────────────────────────────

  server.registerTool(
    "list_dashboards",
    {
      description:
        "List Dynatrace dashboards accessible to you (Document Service). " +
        "Filters to type='dashboard'. Optionally pass pageSize (max 1000).",
      inputSchema: {
        pageSize: z.number().int().positive().max(1000).optional()
          .describe("Number of results per page (default 20, max 1000)."),
      },
    },
    async ({ pageSize }) => {
      const query: Record<string, string | number | boolean | undefined> = {
        filter: "type == 'dashboard'",
      };
      if (pageSize !== undefined) query["page-size"] = pageSize;
      return jsonResult(
        await deps.client.platform.get(DOC_BASE, query),
      );
    },
  );

  // ── get_dashboard ─────────────────────────────────────────────────────────

  server.registerTool(
    "get_dashboard",
    {
      description:
        "Get a dashboard by id — returns combined metadata and content. " +
        "Fetches metadata from /documents/{id}/metadata and content from " +
        "/documents/{id}/content, then merges them into { meta, content }.",
      inputSchema: {
        id: z.string().describe("Dashboard document id."),
      },
    },
    async ({ id }) => {
      const enc = encodeURIComponent(id);
      const [meta, rawContent] = await Promise.all([
        deps.client.platform.get(`${DOC_BASE}/${enc}/metadata`),
        deps.client.platform.getText(`${DOC_BASE}/${enc}/content`),
      ]);

      // Try to parse the content as JSON (dashboards store JSON content).
      // Fall back to the raw string if it is not valid JSON.
      let content: unknown;
      try {
        content = JSON.parse(rawContent);
      } catch {
        content = rawContent;
      }

      return jsonResult({ meta, content });
    },
  );

  // ── create_dashboard ──────────────────────────────────────────────────────

  server.registerTool(
    "create_dashboard",
    {
      description:
        "Create a new dashboard (WRITE). " +
        "Sends a multipart/form-data POST per the Document Service spec. " +
        "The content object is serialized to JSON and sent as the 'content' part " +
        "with Content-Type application/json. " +
        "Requires DT_ENABLE_WRITES=true.",
      inputSchema: {
        name: z.string().max(128).describe("Dashboard display name."),
        content: z.record(z.unknown()).describe("Dashboard content as a JSON object (e.g. { tiles: [] })."),
      },
    },
    async ({ name, content }) => {
      requireWrites(deps.config);

      const form = new FormData();
      form.append("name", name);
      form.append("type", "dashboard");
      // The spec says the content part's Content-Type header determines the
      // stored content type. Node's FormData / Blob supports this via a Blob
      // with a type field.
      const contentBlob = new Blob([JSON.stringify(content)], { type: "application/json" });
      form.append("content", contentBlob, "dashboard.json");

      return jsonResult(
        await deps.client.platform.postForm(DOC_BASE, form),
      );
    },
  );

  // ── update_dashboard ──────────────────────────────────────────────────────

  server.registerTool(
    "update_dashboard",
    {
      description:
        "Update an existing dashboard (WRITE). " +
        "Uses PATCH /documents/{id} with multipart/form-data per the spec. " +
        "Optimistic locking: you must supply the current document version. " +
        "At least one of name or content must be provided. " +
        "Requires DT_ENABLE_WRITES=true.",
      inputSchema: {
        id: z.string().describe("Dashboard document id."),
        version: z.number().int().positive()
          .describe("Current document version for optimistic locking (required by the spec)."),
        name: z.string().max(128).optional().describe("New display name (optional)."),
        content: z.record(z.unknown()).optional()
          .describe("New dashboard content as a JSON object (optional)."),
      },
    },
    async ({ id, version, name, content }) => {
      requireWrites(deps.config);

      const form = new FormData();
      if (name !== undefined) form.append("name", name);
      if (content !== undefined) {
        const contentBlob = new Blob([JSON.stringify(content)], { type: "application/json" });
        form.append("content", contentBlob, "dashboard.json");
      }

      const query: Record<string, string | number | boolean | undefined> = {
        "optimistic-locking-version": String(version),
      };

      return jsonResult(
        await deps.client.platform.patchForm(
          `${DOC_BASE}/${encodeURIComponent(id)}`,
          form,
          query,
        ),
      );
    },
  );

  // ── delete_dashboard ──────────────────────────────────────────────────────

  server.registerTool(
    "delete_dashboard",
    {
      description:
        "Delete (trash) a dashboard by id (WRITE). " +
        "Optimistic locking: you must supply the current document version. " +
        "The document is moved to the trash (restorable for 30 days). " +
        "Requires DT_ENABLE_WRITES=true.",
      inputSchema: {
        id: z.string().describe("Dashboard document id."),
        version: z.number().int().positive()
          .describe("Current document version for optimistic locking (required by the spec)."),
      },
    },
    async ({ id, version }) => {
      requireWrites(deps.config);

      const query: Record<string, string | number | boolean | undefined> = {
        "optimistic-locking-version": String(version),
      };

      const result = await deps.client.platform.del(
        `${DOC_BASE}/${encodeURIComponent(id)}`,
        query,
      );
      return jsonResult(result ?? { deleted: true, id });
    },
  );
}

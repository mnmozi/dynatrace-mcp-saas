/**
 * Notebook tools — backed by Dynatrace Document Service v1
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
import { resolveDocumentContent } from "../util/document-content.js";

const DOC_BASE = "/platform/document/v1/documents";

export function registerNotebookTools(server: McpServer, deps: ToolDeps): void {
  // ── list_notebooks ────────────────────────────────────────────────────────

  server.registerTool(
    "list_notebooks",
    {
      description:
        "List Dynatrace notebooks accessible to you (Document Service). " +
        "Filters to type='notebook'. Optionally pass pageSize (max 1000). " +
        "Returns one page; pass pageKey (from a previous response's nextPageKey) to page through results.",
      inputSchema: {
        pageSize: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Number of results per page (default 20, max 1000)."),
        pageKey: z
          .string()
          .optional()
          .describe(
            "Opaque next-page cursor from a previous response's nextPageKey; pass as page-key to fetch the next page.",
          ),
      },
    },
    async ({ pageSize, pageKey }) => {
      const query: Record<string, string | number | boolean | undefined> = {
        filter: "type == 'notebook'",
      };
      if (pageSize !== undefined) query["page-size"] = pageSize;
      if (pageKey !== undefined) query["page-key"] = pageKey;
      return jsonResult(await deps.client.platform.get(DOC_BASE, query));
    },
  );

  // ── get_notebook ──────────────────────────────────────────────────────────

  server.registerTool(
    "get_notebook",
    {
      description:
        "Get a notebook by id — returns combined metadata and content. " +
        "Fetches metadata from /documents/{id}/metadata and content from " +
        "/documents/{id}/content, then merges them into { meta, content }.",
      inputSchema: {
        id: z.string().describe("Notebook document id."),
      },
    },
    async ({ id }) => {
      const enc = encodeURIComponent(id);
      const [meta, rawContent] = await Promise.all([
        deps.client.platform.get(`${DOC_BASE}/${enc}/metadata`),
        deps.client.platform.getText(`${DOC_BASE}/${enc}/content`),
      ]);

      // Try to parse the content as JSON (notebooks store JSON content).
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

  // ── create_notebook ───────────────────────────────────────────────────────

  server.registerTool(
    "create_notebook",
    {
      description:
        "Create a new notebook (WRITE). " +
        "Sends a multipart/form-data POST per the Document Service spec. " +
        "The content object is serialized to JSON and sent as the 'content' part " +
        "with Content-Type application/json. " +
        "Provide the content inline via 'content' OR from a file via 'contentPath' (not both). " +
        "Requires DT_ENABLE_WRITES=true. " +
        "Call dashboard_reference (topic 'tiles'/'example') first to construct a valid content object.",
      inputSchema: {
        name: z.string().max(128).describe("Notebook display name."),
        content: z.record(z.unknown()).optional().describe("Notebook content as a JSON object (e.g. { cells: [] })."),
        contentPath: z
          .string()
          .optional()
          .describe(
            "Absolute or cwd-relative path to a JSON file whose contents become the notebook content. Provide exactly one of content or contentPath.",
          ),
      },
    },
    async ({ name, content, contentPath }) => {
      requireWrites(deps.config);
      const resolved = await resolveDocumentContent({ content, contentPath }, { required: true });

      const form = new FormData();
      form.append("name", name);
      form.append("type", "notebook");
      // The spec says the content part's Content-Type header determines the
      // stored content type. Node's FormData / Blob supports this via a Blob
      // with a type field.
      const contentBlob = new Blob([JSON.stringify(resolved)], { type: "application/json" });
      form.append("content", contentBlob, "notebook.json");

      return jsonResult(await deps.client.platform.postForm(DOC_BASE, form));
    },
  );

  // ── update_notebook ───────────────────────────────────────────────────────

  server.registerTool(
    "update_notebook",
    {
      description:
        "Update an existing notebook (WRITE). " +
        "Uses PATCH /documents/{id} with multipart/form-data per the spec. " +
        "Optimistic locking: you must supply the current document version. " +
        "At least one of name, content, or contentPath must be provided. " +
        "Requires DT_ENABLE_WRITES=true. " +
        "Call dashboard_reference (topic 'tiles'/'example') first to construct a valid content object.",
      inputSchema: {
        id: z.string().describe("Notebook document id."),
        version: z
          .number()
          .int()
          .positive()
          .describe("Current document version for optimistic locking (required by the spec)."),
        name: z.string().max(128).optional().describe("New display name (optional)."),
        content: z.record(z.unknown()).optional().describe("New notebook content as a JSON object (optional)."),
        contentPath: z
          .string()
          .optional()
          .describe(
            "Absolute or cwd-relative path to a JSON file whose contents become the new notebook content. Mutually exclusive with content.",
          ),
      },
    },
    async ({ id, version, name, content, contentPath }) => {
      requireWrites(deps.config);
      const resolved = await resolveDocumentContent({ content, contentPath });

      if (name === undefined && resolved === undefined) {
        throw new Error("update_notebook requires at least one of 'name', 'content', or 'contentPath' to update.");
      }

      const form = new FormData();
      if (name !== undefined) form.append("name", name);
      if (resolved !== undefined) {
        const contentBlob = new Blob([JSON.stringify(resolved)], { type: "application/json" });
        form.append("content", contentBlob, "notebook.json");
      }

      const query: Record<string, string | number | boolean | undefined> = {
        "optimistic-locking-version": String(version),
      };

      return jsonResult(await deps.client.platform.patchForm(`${DOC_BASE}/${encodeURIComponent(id)}`, form, query));
    },
  );

  // ── delete_notebook ───────────────────────────────────────────────────────

  server.registerTool(
    "delete_notebook",
    {
      description:
        "Delete (trash) a notebook by id (WRITE). " +
        "Optimistic locking: you must supply the current document version. " +
        "The document is moved to the trash (restorable for 30 days). " +
        "Requires DT_ENABLE_WRITES=true.",
      inputSchema: {
        id: z.string().describe("Notebook document id."),
        version: z
          .number()
          .int()
          .positive()
          .describe("Current document version for optimistic locking (required by the spec)."),
      },
    },
    async ({ id, version }) => {
      requireWrites(deps.config);

      const query: Record<string, string | number | boolean | undefined> = {
        "optimistic-locking-version": String(version),
      };

      const result = await deps.client.platform.del(`${DOC_BASE}/${encodeURIComponent(id)}`, query);
      return jsonResult(result ?? { deleted: true, id });
    },
  );
}

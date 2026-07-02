import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/storage/resource-store/v1";

const WRITE_NOTE = "Requires DT_ENABLE_WRITES=true and the platform scope storage:files:write.";

interface ParseOptions {
  parsePattern?: string;
  lookupField?: string;
  autoFlatten?: boolean;
  locale?: string;
}

/** Build the multipart envelope shared by test-pattern and upload: a `request` JSON part + a `content` file part. */
function buildLookupForm(content: string, request: object): FormData {
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
  form.append("content", new Blob([content], { type: "text/csv" }), "lookup.csv");
  return form;
}

const PARSE_INPUTS = {
  parsePattern: z
    .string()
    .describe(
      "DPL (Dynatrace Pattern Language) pattern for parsing each line of the content. REQUIRED — CSV is NOT " +
        "auto-detected (live-verified: the API rejects a blank pattern). For CSV columns use LD (line data), " +
        "e.g. for 'svc-a,team-red,gold': \"LD:id ',' LD:owner ',' LD:tier EOL\". " +
        "Note: STRING: matches non-whitespace runs and typically yields 0 records on comma-separated lines — use LD:.",
    ),
  lookupField: z
    .string()
    .optional()
    .describe(
      "Name of the lookup key field; its values identify a record (records are deduplicated on it during upload).",
    ),
  autoFlatten: z
    .boolean()
    .optional()
    .describe("Extract nested fields to root level when the pattern yields a single record-type field (default true)."),
  locale: z
    .string()
    .optional()
    .describe("Locale for parsing day/month names, e.g. 'en_US' (ISO-639 language + optional ISO-3166 country)."),
};

export function registerResourceStoreTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "test_lookup_pattern",
    {
      description:
        "Test parsing tabular lookup data (Grail Resource Store v1) WITHOUT storing anything. " +
        "Returns how the content would be parsed into records — Dynatrace's authoritative online check. " +
        "Use before upload_lookup_data to verify the parse pattern / CSV structure. Read-only; no write gate.",
      inputSchema: {
        content: z.string().describe("The tabular lookup data to test-parse (e.g. CSV text including header row)."),
        ...PARSE_INPUTS,
      },
    },
    async ({ content, parsePattern, lookupField, autoFlatten, locale }) => {
      const request: ParseOptions = { parsePattern, lookupField, autoFlatten, locale };
      return jsonResult(
        await deps.client.platform.postForm(
          `${BASE}/files/tabular/lookup:test-pattern`,
          buildLookupForm(content, request),
        ),
      );
    },
  );

  server.registerTool(
    "upload_lookup_data",
    {
      description:
        "Upload tabular lookup data into the Grail Resource Store (WRITE, Resource Store v1) for use with the " +
        'DQL `lookup` command (e.g. `| lookup [ load "/lookups/mydata" ], sourceField:id, lookupField:id`). ' +
        "The parse is ALWAYS verified first via the online test-pattern endpoint; on parse failure nothing is " +
        "stored and the verification problems are returned. Set dryRun=true to only verify (no write, no gate). " +
        WRITE_NOTE,
      inputSchema: {
        content: z.string().describe("The tabular lookup data to upload (e.g. CSV text including header row)."),
        filePath: z
          .string()
          .describe("Fully qualified Grail file path to store the data at, e.g. '/lookups/service-owners'."),
        displayName: z.string().max(500).optional().describe("Optional display name for the file."),
        description: z.string().max(500).optional().describe("Optional description for the file."),
        ...PARSE_INPUTS,
        dryRun: z
          .boolean()
          .optional()
          .describe("If true, only run the online parse verification and return the result — nothing is stored."),
      },
    },
    async ({ content, filePath, displayName, description, parsePattern, lookupField, autoFlatten, locale, dryRun }) => {
      const parseOpts: ParseOptions = { parsePattern, lookupField, autoFlatten, locale };

      // Deterministic pre-write guard: Dynatrace's own online parse check. A parse
      // failure throws a DynatraceApiError carrying the API's validation detail,
      // so nothing is persisted and the caller sees the real reason.
      const verify = await deps.client.platform.postForm(
        `${BASE}/files/tabular/lookup:test-pattern`,
        buildLookupForm(content, parseOpts),
      );

      if (dryRun) {
        return jsonResult({ dryRun: true, wouldUpload: { filePath }, verify });
      }

      requireWrites(deps.config);
      const uploadRequest = { filePath, displayName, description, ...parseOpts };
      const result = await deps.client.platform.postForm(
        `${BASE}/files/tabular/lookup:upload`,
        buildLookupForm(content, uploadRequest),
      );
      return jsonResult({ verified: true, result });
    },
  );

  server.registerTool(
    "delete_resource_file",
    {
      description:
        "Delete a file from the Grail Resource Store by path (WRITE, destructive, Resource Store v1). " + WRITE_NOTE,
      inputSchema: {
        filePath: z.string().describe("The fully qualified file path to delete, e.g. '/lookups/service-owners'."),
      },
    },
    async ({ filePath }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(`${BASE}/files:delete`, { filePath }));
    },
  );
}

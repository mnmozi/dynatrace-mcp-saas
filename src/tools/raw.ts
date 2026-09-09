import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

/** raw_post is deliberately restricted to this prefix (ingest is append-only, no validation to bypass). */
const RAW_POST_ALLOWED = /^\/platform\/ingest\//;

/**
 * Read-only raw escape hatch, mirroring the managed MCP's dt_raw_get.
 *
 * raw_get is GET-only. raw_post exists ONLY as a narrowly-scoped ingest escape
 * hatch (/platform/ingest/*): config/settings writes must go through their typed
 * tools so their validation guards (validateOnly / verify / test-pattern) and
 * write-gate semantics are preserved. If a non-ingest write endpoint is missing a
 * typed tool, add the tool instead of widening raw_post.
 */
export function registerRawTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "raw_get",
    {
      description:
        "Perform a raw GET against the Dynatrace API (read-only escape hatch for endpoints/query params " +
        "not yet covered by a typed tool). host='platform' targets the platform host (/platform/*), " +
        "host='classic' targets the classic host (/api/v1, /api/v2), host='account' the Account Management API " +
        "(OAuth; pass scope). Query params are passed verbatim; " +
        "repeat a param by passing an array value. No writes — POST/PUT/DELETE are not exposed raw.",
      inputSchema: {
        host: z
          .enum(["platform", "classic", "iam", "account"])
          .describe(
            "Which host/credential to use: platform, classic, iam (platform host with DT_IAM_TOKEN if configured), " +
              "or account (Account Management API via the OAuth client).",
          ),
        scope: z
          .string()
          .optional()
          .describe(
            "For host='account' only: the OAuth scope to request (e.g. account-idm-read, iam-policies-management, " +
              "account-uac-read). Defaults to DT_OAUTH_SCOPE.",
          ),
        path: z
          .string()
          .regex(/^\//, "path must start with /")
          .describe("Absolute API path, e.g. '/platform/storage/filter-segments/v1/filter-segments/abc'."),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .optional()
          .describe("Query parameters; array values are sent as repeated params (add-fields=A&add-fields=B)."),
      },
    },
    async ({ host, path, query, scope }) => {
      if (host === "account") {
        return jsonResult(await deps.client.requireAccount().get(path, query, scope));
      }
      const client =
        host === "platform" ? deps.client.platform : host === "iam" ? deps.client.iam : deps.client.classic;
      return jsonResult(await client.get(path, query));
    },
  );

  server.registerTool(
    "raw_post",
    {
      description:
        "Raw POST escape hatch — RESTRICTED to OpenPipeline ingest paths (/platform/ingest/*). These are served on " +
        "the ENVIRONMENT (classic) host, so the request goes through the classic client (Api-Token). " +
        "For endpoints not yet covered by a typed ingest tool (e.g. a new/custom ingest source). Any other path is " +
        "rejected: config/settings writes must use their typed tools (which validate first). Ingest is append-only, " +
        "so a failed request is NOT retried (a retry could duplicate the record). " +
        "Requires DT_ENABLE_WRITES=true and a classic API token (DT_API_TOKEN) with the matching openpipeline.* scope.",
      inputSchema: {
        path: z
          .string()
          .regex(RAW_POST_ALLOWED, "raw_post only allows /platform/ingest/* paths — use a typed tool for other writes.")
          .describe("Absolute path under /platform/ingest/, e.g. '/platform/ingest/custom/events/my-endpoint'."),
        body: z
          .union([z.record(z.unknown()), z.array(z.unknown())])
          .describe("JSON request body (a single object or an array)."),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .optional()
          .describe("Optional query parameters."),
        contentType: z.string().optional().describe("Override the Content-Type (default application/json)."),
      },
    },
    async ({ path, body, query, contentType }) => {
      // Defense in depth: re-check the prefix even though the schema regex guards it.
      if (!RAW_POST_ALLOWED.test(path)) {
        throw new Error("raw_post only allows /platform/ingest/* paths.");
      }
      requireWrites(deps.config);
      // /platform/ingest/* is served on the environment/classic host, not the apps host.
      return jsonResult(
        await deps.client.classic.post(path, body, query, { retryClass: "append", contentType }),
      );
    },
  );
}

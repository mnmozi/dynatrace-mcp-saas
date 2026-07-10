import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

/**
 * Read-only raw escape hatch, mirroring the managed MCP's dt_raw_get.
 *
 * Deliberately GET-only: raw writes would bypass the typed tools' validation
 * guards (validateOnly / verify / test-pattern) and the write-gate semantics,
 * so they are NOT exposed. If a write endpoint is missing a typed tool, add
 * the tool instead.
 */
export function registerRawTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "raw_get",
    {
      description:
        "Perform a raw GET against the Dynatrace API (read-only escape hatch for endpoints/query params " +
        "not yet covered by a typed tool). host='platform' targets the platform host (/platform/*), " +
        "host='classic' targets the classic host (/api/v1, /api/v2). Query params are passed verbatim; " +
        "repeat a param by passing an array value. No writes — POST/PUT/DELETE are not exposed raw.",
      inputSchema: {
        host: z
          .enum(["platform", "classic", "iam"])
          .describe(
            "Which host/credential to use: platform, classic, or iam (platform host with DT_IAM_TOKEN if configured).",
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
    async ({ host, path, query }) => {
      const client =
        host === "platform" ? deps.client.platform : host === "iam" ? deps.client.iam : deps.client.classic;
      return jsonResult(await client.get(path, query));
    },
  );
}

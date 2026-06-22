import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

export function registerDqlTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "execute_dql",
    {
      description:
        "Execute a Dynatrace Query Language (DQL) statement against Grail and return the result records. " +
        "Use for logs, spans/traces, events, metrics, and entities. " +
        'Example: \'fetch logs | filter loglevel == "ERROR" | limit 50\'. ' +
        "If you are unsure of DQL syntax, call dql_reference first for embedded Grail DQL knowledge.",
      inputSchema: {
        query: z.string().describe("The DQL statement to execute."),
        maxResultRecords: z
          .number()
          .int()
          .positive()
          .max(10000)
          .optional()
          .describe("Max records to return (default 1000)."),
      },
    },
    async ({ query, maxResultRecords }) => {
      const result = await deps.client.dqlExecute(query, { maxResultRecords });
      return jsonResult({ recordCount: result.records.length, records: result.records });
    },
  );

  server.registerTool(
    "verify_dql",
    {
      description:
        "Validate a DQL statement without returning data (executes with limit 0). " +
        "Returns ok=true or the validation error.",
      inputSchema: {
        query: z.string().describe("The DQL statement to validate."),
      },
    },
    async ({ query }) => {
      try {
        await deps.client.dqlExecute(`${query} | limit 0`, { maxResultRecords: 1 });
        return jsonResult({ ok: true });
      } catch (e) {
        return jsonResult({ ok: false, error: (e as Error).message });
      }
    },
  );
}

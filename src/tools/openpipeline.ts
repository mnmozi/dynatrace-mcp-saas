import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/openpipeline/v1";

export function registerOpenPipelineTools(server: McpServer, deps: ToolDeps): void {
  // ── Read-only tools ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_openpipeline_configurations",
    {
      description:
        "List all OpenPipeline configurations (one per data type: logs, events, bizevents, " +
        "metrics, spans, davis, sdlcEvents, securityEvents, etc.). " +
        "Returns the available data-type configurations with their editable status.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(`${BASE}/configurations`)),
  );

  server.registerTool(
    "get_openpipeline_configuration",
    {
      description:
        "Get the full OpenPipeline configuration for a specific data type (id). " +
        "Returns all endpoints, pipelines, and routing rules. " +
        "Use this to inspect or fetch the config before modifying it with update_openpipeline_configuration.",
      inputSchema: {
        id: z
          .string()
          .describe(
            "Configuration id / data type, e.g. 'logs', 'events', 'bizevents', 'metrics', " +
              "'spans', 'davis', 'sdlcEvents', 'securityEvents'.",
          ),
      },
    },
    async ({ id }) =>
      jsonResult(await deps.client.platform.get(`${BASE}/configurations/${encodeURIComponent(id)}`)),
  );

  server.registerTool(
    "list_openpipeline_technologies",
    {
      description:
        "List all available OpenPipeline technology parsers (grouped by technology category). " +
        "Each technology entry includes its id, name, matcher condition, and allowed configuration types.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(`${BASE}/technologies`)),
  );

  server.registerTool(
    "get_openpipeline_technology_processors",
    {
      description:
        "Get the processors available for a specific OpenPipeline technology. " +
        "Use list_openpipeline_technologies first to find the technology id.",
      inputSchema: {
        id: z.string().describe("Technology id from list_openpipeline_technologies."),
      },
    },
    async ({ id }) =>
      jsonResult(
        await deps.client.platform.get(`${BASE}/technologies/${encodeURIComponent(id)}/processors`),
      ),
  );

  server.registerTool(
    "verify_openpipeline_dql_processor",
    {
      description:
        "Validate a DQL processor script without mutating any configuration (safe, read-only). " +
        "Returns validation errors or a success indicator. " +
        "Use this to author and validate DQL processing scripts before applying them with " +
        "update_openpipeline_configuration.",
      inputSchema: {
        body: z
          .record(z.unknown())
          .describe("Verify request per spec (the DQL processor / script to validate)."),
      },
    },
    async ({ body }) =>
      jsonResult(await deps.client.platform.post(`${BASE}/dqlProcessor/verify`, body)),
  );

  server.registerTool(
    "openpipeline_dql_autocomplete",
    {
      description:
        "Get DQL autocomplete suggestions for a DQL processor script (safe, read-only). " +
        "Useful when authoring pipeline DQL expressions.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Autocomplete request per spec."),
      },
    },
    async ({ body }) =>
      jsonResult(await deps.client.platform.post(`${BASE}/dqlProcessor/autocomplete`, body)),
  );

  server.registerTool(
    "verify_openpipeline_matcher",
    {
      description:
        "Validate a matcher (routing condition) expression without mutating any configuration (safe, read-only). " +
        "Use this to validate routing conditions before applying them with update_openpipeline_configuration.",
      inputSchema: {
        body: z
          .record(z.unknown())
          .describe("Matcher (routing condition) verify request per spec."),
      },
    },
    async ({ body }) =>
      jsonResult(await deps.client.platform.post(`${BASE}/matcher/verify`, body)),
  );

  server.registerTool(
    "openpipeline_matcher_autocomplete",
    {
      description:
        "Get autocomplete suggestions for a matcher (routing condition) expression (safe, read-only). " +
        "Useful when authoring pipeline routing conditions.",
      inputSchema: {
        body: z.record(z.unknown()).describe("Matcher autocomplete request per spec."),
      },
    },
    async ({ body }) =>
      jsonResult(await deps.client.platform.post(`${BASE}/matcher/autocomplete`, body)),
  );

  server.registerTool(
    "convert_lql_to_dql",
    {
      description:
        "Convert a legacy LQL (Log Query Language) matcher expression to a DQL (Dynatrace Query Language) " +
        "equivalent (safe, read-only). Useful when migrating older pipeline routing conditions.",
      inputSchema: {
        body: z
          .record(z.unknown())
          .describe(
            "LQL-to-DQL conversion request per spec (e.g. the LQL matcher string).",
          ),
      },
    },
    async ({ body }) =>
      jsonResult(await deps.client.platform.post(`${BASE}/matcher/lqlToDql`, body)),
  );

  server.registerTool(
    "preview_openpipeline_processor",
    {
      description:
        "Preview the effect of a pipeline processor on sample data without mutating any configuration " +
        "(safe, read-only). " +
        "Returns per-record match and transformed record results. " +
        "Use this to author and validate processors before applying them with update_openpipeline_configuration. " +
        "Include a 'sampleData' string field (JSON-encoded record) inside the processor definition.",
      inputSchema: {
        processor: z
          .record(z.unknown())
          .describe(
            "Processor definition (type, matcher, fields, etc.). " +
              "Include a 'sampleData' string field with a JSON-encoded record to test against, " +
              "per the PreviewProcessorEnvelope spec. " +
              "Example: { type: 'fieldsRename', sampleData: '{\"hostname\":\"my-host\"}', " +
              "fields: [{ fromName: 'hostname', toName: 'host.name' }] }",
          ),
      },
    },
    async ({ processor }) =>
      // POST body is PreviewProcessorEnvelope: { processor: <PreviewProcessor> }
      // sampleData is a field *inside* the processor object (not a sibling).
      jsonResult(
        await deps.client.platform.post(`${BASE}/preview/processor`, { processor }),
      ),
  );

  // ── Write tool (gated) ───────────────────────────────────────────────────────

  server.registerTool(
    "update_openpipeline_configuration",
    {
      description:
        "Replace the full OpenPipeline configuration for a specific data type (WRITE, requires DT_ENABLE_WRITES=true). " +
        "Fetch the current configuration first with get_openpipeline_configuration, modify it, then PUT it back. " +
        "This replaces the entire configuration object.",
      inputSchema: {
        id: z
          .string()
          .describe(
            "Configuration id / data type to update, e.g. 'logs', 'events', 'bizevents', 'metrics'.",
          ),
        configuration: z
          .record(z.unknown())
          .describe(
            "Full configuration object (typically fetched via get_openpipeline_configuration, then modified). " +
              "PUT replaces the whole configuration.",
          ),
      },
    },
    async ({ id, configuration }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/configurations/${encodeURIComponent(id)}`,
          configuration,
        ),
      );
    },
  );
}

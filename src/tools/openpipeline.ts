import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import type { HostClient } from "../types.js";
import {
  openPipelineProcessorSchema,
  openPipelineConfigurationSchema,
  dqlProcessorVerifySchema,
  dqlProcessorAutocompleteSchema,
  matcherVerifySchema,
  matcherAutocompleteSchema,
  lqlToDqlSchema,
} from "../schemas/openpipeline.js";

const BASE = "/platform/openpipeline/v1";

// ── Deep-walk helpers ────────────────────────────────────────────────────────

interface DqlItem {
  kind: "dql";
  location: string;
  script: string;
}

interface MatcherItem {
  kind: "matcher";
  location: string;
  value: string;
}

type CollectedItem = DqlItem | MatcherItem;

/**
 * Recursively walks `node` and collects:
 *  - DQL processors: any object with `type === "dql"`, capturing its script (see dqlProcessorScript)
 *  - Matchers: any property literally named `matcher` whose value is a non-empty string
 */
function collectVerifyItems(node: unknown, path: string, out: CollectedItem[]): void {
  if (node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => collectVerifyItems(item, `${path}[${i}]`, out));
    return;
  }

  const obj = node as Record<string, unknown>;

  if (obj["type"] === "dql") {
    const script = dqlProcessorScript(obj);
    if (script) {
      out.push({ kind: "dql", location: path, script });
    }
  }

  // Walk all properties, collecting string-valued `matcher` properties
  for (const key of Object.keys(obj)) {
    if (key === "matcher") {
      if (typeof obj[key] === "string" && (obj[key] as string).length > 0) {
        out.push({ kind: "matcher", location: `${path}.matcher`, value: obj[key] as string });
      }
      // Still recurse into matcher if it's an object (unlikely but defensive)
      if (typeof obj[key] === "object") {
        collectVerifyItems(obj[key], `${path}.matcher`, out);
      }
    } else {
      collectVerifyItems(obj[key], `${path}.${key}`, out);
    }
  }
}

/**
 * A DQL processor keeps its script in a different place per API generation: Settings 2.0
 * pipelines nest it as `dql.script`; the retired Configurations API shape carried it on the
 * processor itself as `dqlScript` (or `script`).
 */
function dqlProcessorScript(processor: Record<string, unknown>): string | undefined {
  const nested = processor["dql"];
  const candidates = [
    processor["dqlScript"],
    processor["script"],
    nested !== null && typeof nested === "object" ? (nested as Record<string, unknown>)["script"] : undefined,
  ];
  return candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

interface VerifyResult {
  kind: "dql" | "matcher";
  location: string;
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

interface RawVerifyResponse {
  valid?: boolean;
  notifications?: Array<{ severity?: string; message?: string }>;
}

function interpretVerifyResponse(raw: RawVerifyResponse): { valid: boolean; errors: string[]; warnings: string[] } {
  // Fail-transparent 3-case: invalid ONLY on an explicit failure signal — either
  // valid===false, or an ERROR-severity notification. Ambiguity (no `valid` field,
  // only WARN notifications) still counts as valid, but the warnings are surfaced
  // so the caller can see what the online check flagged.
  const valid = raw.valid !== false && !(raw.notifications ?? []).some((n) => n.severity === "ERROR");
  const errors = (raw.notifications ?? [])
    .filter((n) => n.severity === "ERROR")
    .map((n) => n.message ?? "Unknown error");
  const warnings = (raw.notifications ?? [])
    .filter((n) => n.severity && n.severity !== "ERROR")
    .map((n) => n.message ?? "Unknown warning");
  return { valid, errors, warnings };
}

/** Verify one collected DQL script or matcher through its online verify endpoint. */
async function verifyItem(platform: HostClient, scopeId: string, item: CollectedItem): Promise<VerifyResult> {
  const raw =
    item.kind === "dql"
      ? await platform.post<RawVerifyResponse>(`${BASE}/dqlProcessor/verify`, {
          script: item.script,
          configurationId: scopeId,
        })
      : await platform.post<RawVerifyResponse>(`${BASE}/matcher/verify`, {
          query: item.value,
          configurationId: scopeId,
        });
  return { kind: item.kind, location: item.location, ...interpretVerifyResponse(raw) };
}

export function registerOpenPipelineTools(server: McpServer, deps: ToolDeps): void {
  // ── Read-only tools ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_openpipeline_scopes",
    {
      description:
        "List the OpenPipeline data-type scopes (logs, events, bizevents, metrics, spans, security.events, " +
        "events.sdlc, davis.events, davis.problems, user.events, usersessions, smartscape.events, system.events) " +
        "with each scope's capability DEFINITION: allowed processors per stage, custom-endpoint base path, default " +
        "bucket. NOTE: the actual pipelines/routing/ingest-sources are NOT here — they are Settings 2.0 objects " +
        "(builtin:openpipeline.<scope>.pipelines / .routing / .ingest-sources); read them with list_settings_objects.",
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.platform.get(`${BASE}/configurations`)),
  );

  server.registerTool(
    "get_openpipeline_scope_definition",
    {
      description:
        "Get a data-type scope's OpenPipeline capability DEFINITION (id): the per-stage processor allow-list " +
        "(pipelinesSpecification), whether custom endpoints exist + their base path (endpointsSpecification), " +
        "and the default bucket/table (bucketsSpecification). Use it to learn WHICH processor types a scope " +
        "supports before authoring (e.g. 'metrics' has no metricExtraction/storage; 'spans' uses samplingAware*; " +
        "'system.events' has an empty processing stage). It does NOT return the actual pipelines or routing — " +
        "those are Settings 2.0 objects (builtin:openpipeline.<scope>.pipelines / .routing); read them with " +
        "get/list_settings_objects.",
      inputSchema: {
        id: z
          .string()
          .describe(
            "Scope id / data type, e.g. 'logs', 'events', 'bizevents', 'metrics', 'spans', " +
              "'security.events', 'events.sdlc', 'davis.events', 'davis.problems', 'user.events', " +
              "'usersessions', 'smartscape.events', 'system.events'.",
          ),
      },
    },
    async ({ id }) => {
      try {
        return jsonResult(await deps.client.platform.get(`${BASE}/configurations/${encodeURIComponent(id)}`));
      } catch (err) {
        // Some tenants (during/after platform migration) disable GET-by-id, but the
        // list endpoint carries each configuration's full `definition` inline.
        // Fall back to the list and return the matching configuration.
        const all = await deps.client.platform.get<Array<{ id?: string }>>(`${BASE}/configurations`);
        const match = Array.isArray(all) ? all.find((c) => c?.id === id) : undefined;
        if (match) return jsonResult(match);
        throw err;
      }
    },
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
      jsonResult(await deps.client.platform.get(`${BASE}/technologies/${encodeURIComponent(id)}/processors`)),
  );

  server.registerTool(
    "verify_openpipeline_dql_processor",
    {
      description:
        "Validate a DQL processor script without mutating any configuration (safe, read-only). " +
        "Returns validation errors or a success indicator. " +
        "Use this to author and validate a DQL processing script before writing it into a pipeline with " +
        "create/update_settings_object (builtin:openpipeline.<scope>.pipelines).",
      inputSchema: {
        body: dqlProcessorVerifySchema.describe(
          "DQL processor verify request: script (the DQL script to validate), optional configurationId, protectedFields.",
        ),
      },
    },
    async ({ body }) => jsonResult(await deps.client.platform.post(`${BASE}/dqlProcessor/verify`, body)),
  );

  server.registerTool(
    "openpipeline_dql_autocomplete",
    {
      description:
        "Get DQL autocomplete suggestions for a DQL processor script (safe, read-only). " +
        "Useful when authoring pipeline DQL expressions.",
      inputSchema: {
        body: dqlProcessorAutocompleteSchema.describe(
          "DQL processor autocomplete request: script (in-progress DQL), cursorPosition, optional configurationId, protectedFields.",
        ),
      },
    },
    async ({ body }) => jsonResult(await deps.client.platform.post(`${BASE}/dqlProcessor/autocomplete`, body)),
  );

  server.registerTool(
    "verify_openpipeline_matcher",
    {
      description:
        "Validate a matcher (routing condition) expression without mutating any configuration (safe, read-only). " +
        "Use this to validate a routing or processor condition before writing it with " +
        "create/update_settings_object (builtin:openpipeline.<scope>.routing / .pipelines).",
      inputSchema: {
        body: matcherVerifySchema.describe(
          "Matcher verify request: query (the matcher expression), optional configurationId, context, restrictedFields.",
        ),
      },
    },
    async ({ body }) => jsonResult(await deps.client.platform.post(`${BASE}/matcher/verify`, body)),
  );

  server.registerTool(
    "openpipeline_matcher_autocomplete",
    {
      description:
        "Get autocomplete suggestions for a matcher (routing condition) expression (safe, read-only). " +
        "Useful when authoring pipeline routing conditions.",
      inputSchema: {
        body: matcherAutocompleteSchema.describe(
          "Matcher autocomplete request: query (in-progress matcher expression), cursorPosition.",
        ),
      },
    },
    async ({ body }) => jsonResult(await deps.client.platform.post(`${BASE}/matcher/autocomplete`, body)),
  );

  server.registerTool(
    "convert_lql_to_dql",
    {
      description:
        "Convert a legacy LQL (Log Query Language) matcher expression to a DQL (Dynatrace Query Language) " +
        "equivalent (safe, read-only). Useful when migrating older pipeline routing conditions.",
      inputSchema: {
        body: lqlToDqlSchema.describe(
          "LQL-to-DQL conversion request: query (the LQL matcher string to convert, e.g. 'log.source=\"snmptraps\"').",
        ),
      },
    },
    async ({ body }) => jsonResult(await deps.client.platform.post(`${BASE}/matcher/lqlToDql`, body)),
  );

  server.registerTool(
    "preview_openpipeline_processor",
    {
      description:
        "Preview the effect of a pipeline processor on sample data without mutating any configuration " +
        "(safe, read-only). " +
        "Returns per-record match and transformed record results. " +
        "Use this to author and validate a processor before writing it into a pipeline with " +
        "create/update_settings_object (builtin:openpipeline.<scope>.pipelines). " +
        "Include a 'sampleData' string field (JSON-encoded record) inside the processor definition.",
      inputSchema: {
        processor: openPipelineProcessorSchema.describe(
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
      jsonResult(await deps.client.platform.post(`${BASE}/preview/processor`, { processor })),
  );

  // ── Code-driven read-only helpers ───────────────────────────────────────────

  server.registerTool(
    "preview_openpipeline_pipeline",
    {
      description:
        "Preview the effect of an ORDERED SEQUENCE of processors by threading a record through each one " +
        "via repeated /preview/processor API calls (safe, read-only). " +
        "Each step's output record becomes the next step's input — this is pure-code orchestration, " +
        "not a bulk API call. " +
        "Returns a per-step trace (matched, record) and the finalRecord after all steps. " +
        "Stops at the first step that returns an error.",
      inputSchema: {
        processors: z
          .array(openPipelineProcessorSchema)
          .min(1)
          .describe(
            "Ordered list of processor definitions (each like a single-preview processor: " +
              "type, id, matcher, fields, ...). Do NOT include sampleData; the tool injects it per step.",
          ),
        sampleData: z
          .union([z.string(), z.record(z.unknown())])
          .describe("Initial record to feed the pipeline: a JSON-encoded string OR an object."),
      },
    },
    async ({ processors, sampleData }) => {
      let current: Record<string, unknown> =
        typeof sampleData === "string"
          ? (JSON.parse(sampleData) as Record<string, unknown>)
          : (sampleData as Record<string, unknown>);

      const steps: Array<Record<string, unknown>> = [];
      for (let i = 0; i < processors.length; i++) {
        const proc = {
          ...(processors[i] as Record<string, unknown>),
          sampleData: JSON.stringify(current),
        };
        try {
          const res = await deps.client.platform.post<{
            results?: Array<{
              matched?: boolean;
              record?: Record<string, unknown>;
              matchedProcessors?: string[];
            }>;
          }>(`${BASE}/preview/processor`, { processor: proc });
          const r = res.results?.[0];
          const matched = r?.matched ?? false;
          steps.push({
            index: i,
            processorId: (processors[i] as Record<string, unknown>).id,
            type: (processors[i] as Record<string, unknown>).type,
            matched,
            record: r?.record,
          });
          if (matched && r?.record) current = r.record;
        } catch (e) {
          steps.push({
            index: i,
            processorId: (processors[i] as Record<string, unknown>).id,
            error: (e as Error).message,
          });
          break;
        }
      }
      return jsonResult({ steps, finalRecord: current });
    },
  );

  server.registerTool(
    "list_openpipeline_processor_types",
    {
      description:
        "List, per data type, the processor types allowed in each pipeline stage " +
        "(parsed from each configuration's pipelinesSpecification). " +
        "Useful for discovering which processor types (e.g. 'fieldsAdd', 'dql', 'drop', 'geoLookup') " +
        "are valid in a given stage for a given data type. Read-only.",
      inputSchema: {
        configId: z
          .string()
          .optional()
          .describe("Optional data-type id (e.g. 'logs') to return only that one; omit for all."),
      },
    },
    async ({ configId }) => {
      const all = await deps.client.platform.get<
        Array<{
          id?: string;
          definition?: { pipelinesSpecification?: Record<string, unknown> };
        }>
      >(`${BASE}/configurations`);
      const list = Array.isArray(all) ? all : [];
      const filtered = configId ? list.filter((c) => c.id === configId) : list;
      const result = filtered.map((c) => ({
        id: c.id,
        stages: c.definition?.pipelinesSpecification ?? {},
      }));
      return jsonResult(result);
    },
  );

  server.registerTool(
    "verify_openpipeline_configuration",
    {
      description:
        "Batch-verify every DQL processor script and every matcher found anywhere in an OpenPipeline object, via " +
        "the online verify endpoints (safe, read-only). Pass the value you are about to write with " +
        "create/update_settings_object (builtin:openpipeline.<scope>.pipelines / .routing): the whole tree is " +
        "walked, so one call covers all its processors and routing conditions. Returns valid:true with the counts " +
        "verified, or valid:false with each failing item's location and Dynatrace's errors. This tool writes " +
        "nothing: OpenPipeline is changed through those Settings 2.0 objects (see openpipeline_reference topic " +
        "'authoring').",
      inputSchema: {
        id: z
          .string()
          .describe(
            "Scope id / data type the scripts and matchers are verified against, e.g. 'logs', 'events', " +
              "'bizevents', 'spans'.",
          ),
        configuration: openPipelineConfigurationSchema.describe(
          "The object to verify: a Settings 2.0 pipelines or routing value, or any JSON tree holding DQL " +
            "processors (type:'dql') and matcher strings.",
        ),
      },
    },
    async ({ id, configuration }) => {
      const items: CollectedItem[] = [];
      collectVerifyItems(configuration, "configuration", items);

      const results = await Promise.all(items.map((item) => verifyItem(deps.client.platform, id, item)));

      const problems = results.filter((result) => !result.valid);
      if (problems.length > 0) {
        return jsonResult({ valid: false, problems });
      }

      // The online checks can pass an item and still flag it; surface that without failing.
      const warnings = results
        .filter((result) => (result.warnings?.length ?? 0) > 0)
        .map((result) => ({ location: result.location, warnings: result.warnings }));
      return jsonResult({
        valid: true,
        verified: {
          dqlProcessors: items.filter((item) => item.kind === "dql").length,
          matchers: items.filter((item) => item.kind === "matcher").length,
        },
        ...(warnings.length > 0 ? { validationWarnings: warnings } : {}),
      });
    },
  );
}

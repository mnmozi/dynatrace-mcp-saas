import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

const BASE = "/platform/davis/analyzers/v1/analyzers";

interface AnalyzerExecuteResult {
  requestToken?: string;
  ttlInSeconds?: number;
  result?: {
    executionStatus?: string;
    resultStatus?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface AnalyzerValidationResult {
  valid: boolean;
  details?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerDavisAnalyzerTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_davis_analyzers",
    {
      description:
        "List available Davis analyzers (Davis Analyzers v1) — forecasting (GenericForecastAnalyzer), " +
        "anomaly detection (auto-adaptive / seasonal-baseline / static-threshold), log pattern extraction, " +
        "novelty scoring. Use get_davis_analyzer_input_schema to see what input an analyzer takes.",
      inputSchema: {
        pageKey: z.string().optional().describe("nextPageKey from a previous call to fetch the next page."),
      },
    },
    async ({ pageKey }) =>
      jsonResult(await deps.client.platform.get(BASE, pageKey ? { "page-key": pageKey } : { "page-size": "100" })),
  );

  server.registerTool(
    "get_davis_analyzer",
    {
      description: "Get a Davis analyzer definition by fully qualified name (Davis Analyzers v1).",
      inputSchema: {
        name: z.string().describe("Fully qualified analyzer name, e.g. 'dt.statistics.GenericForecastAnalyzer'."),
      },
    },
    async ({ name }) => jsonResult(await deps.client.platform.get(`${BASE}/${encodeURIComponent(name)}`)),
  );

  server.registerTool(
    "get_davis_analyzer_input_schema",
    {
      description:
        "Get the JSON schema describing an analyzer's input (Davis Analyzers v1). Use this to ground the " +
        "'input' body for validate/execute — the schema is the authoritative source for required fields " +
        "(e.g. timeSeriesData query, forecastHorizon).",
      inputSchema: {
        name: z.string().describe("Fully qualified analyzer name."),
      },
    },
    async ({ name }) =>
      jsonResult(await deps.client.platform.get(`${BASE}/${encodeURIComponent(name)}/json-schema/input`)),
  );

  server.registerTool(
    "validate_davis_analyzer_input",
    {
      description:
        "Validate analyzer input WITHOUT executing (online dry-run, Davis Analyzers v1). Returns {valid, details}. " +
        "Note: analyzer DQL queries must produce a timeseries shape (timeseries / makeTimeseries) and must NOT " +
        "pin from:/to: — the analyzer supplies the timeframe.",
      inputSchema: {
        name: z.string().describe("Fully qualified analyzer name."),
        input: z.record(z.unknown()).describe("Analyzer input body (shape per get_davis_analyzer_input_schema)."),
      },
    },
    async ({ name, input }) =>
      jsonResult(await deps.client.platform.post(`${BASE}/${encodeURIComponent(name)}:validate`, input)),
  );

  server.registerTool(
    "execute_davis_analyzer",
    {
      description:
        "Execute a Davis analyzer (Davis Analyzers v1) — e.g. forecast a timeseries with " +
        "dt.statistics.GenericForecastAnalyzer. The input is ALWAYS validated online first; on validation " +
        "failure nothing is executed and the problems are returned. Long-running executions (HTTP 202) are " +
        "polled automatically until completion. Read-only analytics — no write gate. " +
        "Query rules: output must be timeseries-shaped (timeseries / makeTimeseries) and must NOT pin " +
        "from:/to: — the analyzer controls the evaluation timeframe.",
      inputSchema: {
        name: z.string().describe("Fully qualified analyzer name, e.g. 'dt.statistics.GenericForecastAnalyzer'."),
        input: z.record(z.unknown()).describe("Analyzer input body (shape per get_davis_analyzer_input_schema)."),
        pollTimeoutMs: z
          .number()
          .int()
          .positive()
          .max(300_000)
          .optional()
          .describe("Max total time to poll a long-running execution (default 60000 ms)."),
      },
    },
    async ({ name, input, pollTimeoutMs }) => {
      const encoded = encodeURIComponent(name);

      // Deterministic pre-execution guard: Dynatrace's own online validation.
      const validation = await deps.client.platform.post<AnalyzerValidationResult>(
        `${BASE}/${encoded}:validate`,
        input,
      );
      if (validation.valid === false) {
        return jsonResult({ executed: false, valid: false, details: validation.details ?? null });
      }

      let res = await deps.client.platform.post<AnalyzerExecuteResult>(`${BASE}/${encoded}:execute`, input);

      // 202 path: long-running execution — poll with the request token until it completes.
      const deadline = Date.now() + (pollTimeoutMs ?? 60_000);
      let waitMs = 500;
      // Initial 202 may carry only a requestToken (no result yet); keep polling until
      // a result arrives with a non-RUNNING executionStatus.
      while (res.requestToken && (res.result === undefined || res.result.executionStatus === "RUNNING")) {
        if (Date.now() > deadline) {
          return jsonResult({
            executed: true,
            completed: false,
            note: "Polling timed out; execution may still be running.",
            requestToken: res.requestToken,
            partial: res,
          });
        }
        await sleep(waitMs);
        waitMs = Math.min(waitMs * 2, 4000);
        res = await deps.client.platform.get<AnalyzerExecuteResult>(`${BASE}/${encoded}:poll`, {
          "request-token": res.requestToken,
        });
      }

      return jsonResult({ executed: true, completed: true, ...res });
    },
  );
}

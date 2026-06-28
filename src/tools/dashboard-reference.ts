import { z } from "zod";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, jsonResult } from "../util/result.js";

// Vendored official Dynatrace skills (Apache-2.0) — see knowledge/dashboards/vendor/dynatrace-for-ai/LICENSE
const VENDOR_DIR = fileURLToPath(
  new URL("../../knowledge/dashboards/vendor/dynatrace-for-ai/", import.meta.url),
);

const TOPIC_MAP = {
  skill: {
    file: "dt-app-dashboards/SKILL.md",
    desc: "Dynatrace Dashboard Skill entry point — start here before composing any dashboard JSON",
    mimeType: "text/markdown",
  },
  tiles: {
    file: "dt-app-dashboards/references/tiles.md",
    desc: "Dashboard tile types and visualization types with required field details",
    mimeType: "text/markdown",
  },
  visualizations: {
    file: "dt-app-dashboards/assets/visualization-settings.reference.jsonc",
    desc: "Per-visualization settings reference (JSONC) — all configurable fields per viz type",
    mimeType: "application/json",
  },
  variables: {
    file: "dt-app-dashboards/references/variables.md",
    desc: "Dashboard variables — types, configuration, and usage in DQL queries",
    mimeType: "text/markdown",
  },
  "create-update": {
    file: "dt-app-dashboards/references/create-update.md",
    desc: "Step-by-step guide for creating and updating dashboards via the Document Service API",
    mimeType: "text/markdown",
  },
  analyzing: {
    file: "dt-app-dashboards/references/analyzing.md",
    desc: "Guide for analyzing and reading existing dashboard JSON",
    mimeType: "text/markdown",
  },
  example: {
    file: "dt-app-dashboards/assets/ExampleDashboard.json",
    desc: "Complete example dashboard JSON with multiple tile types and visualizations",
    mimeType: "application/json",
  },
  notebooks: {
    file: "dt-app-notebooks/SKILL.md",
    desc: "Dynatrace Notebook Skill entry point — start here before composing any notebook JSON",
    mimeType: "text/markdown",
  },
  "notebook-sections": {
    file: "dt-app-notebooks/references/sections.md",
    desc: "Notebook section types and configuration",
    mimeType: "text/markdown",
  },
  "notebook-create-update": {
    file: "dt-app-notebooks/references/create-update.md",
    desc: "Step-by-step guide for creating and updating notebooks via the Document Service API",
    mimeType: "text/markdown",
  },
  "notebook-example": {
    file: "dt-app-notebooks/assets/ExampleNotebook.json",
    desc: "Complete example notebook JSON",
    mimeType: "application/json",
  },
} as const;

type Topic = keyof typeof TOPIC_MAP;

const topicEnum = z.enum(Object.keys(TOPIC_MAP) as [Topic, ...Topic[]]);

export function registerDashboardReferenceTools(server: McpServer): void {
  // ── Tool: dashboard_reference ────────────────────────────────────────────────
  server.registerTool(
    "dashboard_reference",
    {
      description:
        "Return embedded Dynatrace dashboard/notebook authoring knowledge (tile types, visualizations + required field types, variables, full examples). " +
        "Call BEFORE composing a dashboard/notebook 'content' object for create_dashboard/create_notebook/update_*. " +
        "Default topic 'skill'; use 'tiles' for tile types, 'visualizations' for per-viz settings, 'example' for a complete dashboard JSON.",
      inputSchema: {
        topic: topicEnum
          .optional()
          .describe(
            "Which knowledge doc to return: skill (default, dashboard overview), tiles (tile types + viz types), " +
            "visualizations (per-viz settings JSONC), variables, create-update, analyzing, example (full dashboard JSON), " +
            "notebooks (notebook skill), notebook-sections, notebook-create-update, notebook-example.",
          ),
      },
    },
    async ({ topic }) => {
      const resolved: Topic = (topic as Topic | undefined) ?? "skill";
      const { file } = TOPIC_MAP[resolved];
      const filePath = `${VENDOR_DIR}${file}`;
      try {
        return textResult(await readFile(filePath, "utf-8"));
      } catch (err) {
        return textResult(
          `Error: could not read dashboard knowledge doc '${file}' at '${filePath}': ${(err as Error).message}`,
        );
      }
    },
  );

  // ── Tool: list_dashboard_topics ──────────────────────────────────────────────
  server.registerTool(
    "list_dashboard_topics",
    {
      description:
        "List the dashboard/notebook knowledge topics fetchable via dashboard_reference (with one-line descriptions). " +
        "Covers both dashboards (tile types, visualizations, variables, examples) and notebooks (sections, examples).",
      inputSchema: {},
    },
    async () => {
      const topics = Object.entries(TOPIC_MAP).map(([key, { desc }]) => ({
        topic: key,
        description: desc,
      }));
      return jsonResult({
        availableTopics: topics,
        note: "Use dashboard_reference({topic}) to fetch a doc. Default topic is 'skill'.",
      });
    },
  );

  // ── Resources: dashboard:// ──────────────────────────────────────────────────
  for (const [key, { file, desc, mimeType }] of Object.entries(TOPIC_MAP)) {
    const uri = `dashboard://${key}`;
    const filePath = `${VENDOR_DIR}${file}`;
    server.resource(
      `dashboard-${key}`,
      uri,
      { description: desc, mimeType },
      async (resourceUri) => {
        try {
          const text = await readFile(filePath, "utf-8");
          return { contents: [{ uri: resourceUri.href, mimeType, text }] };
        } catch (err) {
          return {
            contents: [
              {
                uri: resourceUri.href,
                mimeType: "text/plain",
                text: `Error reading ${file}: ${(err as Error).message}`,
              },
            ],
          };
        }
      },
    );
  }
}

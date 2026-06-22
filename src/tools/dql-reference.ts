import { z } from "zod";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, jsonResult } from "../util/result.js";

const KNOWLEDGE_DIR = fileURLToPath(new URL("../../knowledge/dql/", import.meta.url));

const TOPIC_MAP = {
  playbook:       { file: "dql-skill.md",                     desc: "Compact agent cheat-sheet — start here before writing any DQL" },
  reference:      { file: "dql-reference.md",                  desc: "Full practical DQL reference guide" },
  metrics:        { file: "dql-metrics-and-self-monitoring.md", desc: "Metrics and self-monitoring queries" },
  gotchas:        { file: "dql-filter-after-summarize-bug.md",  desc: "Gotcha: filter silently dropped after summarize (optimizer bug)" },
  "business-cases": { file: "dql-business-cases.md",           desc: "Business-oriented DQL query patterns" },
  k8s:            { file: "dql-k8s-investigation.md",           desc: "Kubernetes investigation DQL queries" },
} as const;

type Topic = keyof typeof TOPIC_MAP;

const topicEnum = z.enum(
  Object.keys(TOPIC_MAP) as [Topic, ...Topic[]],
);

export function registerDqlReferenceTools(server: McpServer): void {
  // ── Tool: dql_reference ──────────────────────────────────────────────────
  server.registerTool(
    "dql_reference",
    {
      description:
        "Return embedded Dynatrace DQL (Grail) authoring knowledge so you can WRITE DQL yourself " +
        "(then run it with execute_dql / query_metric / search_logs). " +
        "Self-contained — does NOT call Dynatrace GenAI. " +
        "Call this BEFORE composing any non-trivial DQL. " +
        "Default topic 'playbook' is the compact agent cheat-sheet; " +
        "use 'reference' for the full guide, or a focused topic.",
      inputSchema: {
        topic: topicEnum
          .optional()
          .describe(
            "Which knowledge doc: playbook (default, compact cheat-sheet), reference (full), " +
            "metrics, gotchas (filter-after-summarize bug), business-cases, k8s.",
          ),
      },
    },
    async ({ topic }) => {
      const resolved: Topic = (topic as Topic | undefined) ?? "playbook";
      const { file } = TOPIC_MAP[resolved];
      const filePath = `${KNOWLEDGE_DIR}${file}`;
      try {
        const content = await readFile(filePath, "utf-8");
        return textResult(content);
      } catch (err) {
        return textResult(
          `Error: could not read DQL knowledge doc '${file}' at '${filePath}': ${(err as Error).message}`,
        );
      }
    },
  );

  // ── Tool: list_dql_topics ────────────────────────────────────────────────
  server.registerTool(
    "list_dql_topics",
    {
      description:
        "List all available DQL knowledge topics (and one-line descriptions) that can be fetched " +
        "via dql_reference. Useful for discovering what knowledge is bundled.",
      inputSchema: {},
    },
    async () => {
      const topics = Object.entries(TOPIC_MAP).map(([key, { desc }]) => ({
        topic: key,
        description: desc,
      }));
      return jsonResult({ availableTopics: topics });
    },
  );

  // ── Resources: dql:// ─────────────────────────────────────────────────────
  // SDK ^1.12.0 supports server.resource(name, uri, metadata?, readCallback)
  for (const [key, { file, desc }] of Object.entries(TOPIC_MAP)) {
    const uri = `dql://${key}`;
    const filePath = `${KNOWLEDGE_DIR}${file}`;
    server.resource(
      `dql-${key}`,
      uri,
      { description: desc, mimeType: "text/markdown" },
      async (resourceUri) => {
        try {
          const text = await readFile(filePath, "utf-8");
          return { contents: [{ uri: resourceUri.href, mimeType: "text/markdown", text }] };
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

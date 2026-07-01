import { z } from "zod";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, jsonResult } from "../util/result.js";

const KNOWLEDGE_DIR = fileURLToPath(new URL("../../knowledge/dql/", import.meta.url));
// Vendored official Dynatrace skill (Apache-2.0) — see vendor/dynatrace-for-ai/LICENSE
const OFFICIAL_REFS_DIR = fileURLToPath(
  new URL("../../knowledge/dql/vendor/dynatrace-for-ai/dt-dql-essentials/references/", import.meta.url),
);

const TOPIC_MAP = {
  playbook: { file: "dql-skill.md", desc: "Compact agent cheat-sheet — start here before writing any DQL" },
  reference: { file: "dql-reference.md", desc: "Full practical DQL reference guide" },
  metrics: { file: "dql-metrics-and-self-monitoring.md", desc: "Metrics and self-monitoring queries" },
  gotchas: {
    file: "dql-filter-after-summarize-bug.md",
    desc: "Gotcha: filter silently dropped after summarize (optimizer bug)",
  },
  "business-cases": { file: "dql-business-cases.md", desc: "Business-oriented DQL query patterns" },
  k8s: { file: "dql-k8s-investigation.md", desc: "Kubernetes investigation DQL queries" },
  official: {
    file: "vendor/dynatrace-for-ai/dt-dql-essentials/SKILL.md",
    desc: "Official Dynatrace dt-dql-essentials skill entry point (Apache-2.0); use officialRef to fetch its function-reference docs",
  },
} as const;

type Topic = keyof typeof TOPIC_MAP;

const topicEnum = z.enum(Object.keys(TOPIC_MAP) as [Topic, ...Topic[]]);

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
        "Default topic 'playbook' is the compact agent cheat-sheet; 'reference' is the full guide; " +
        "'official' is Dynatrace's bundled dt-dql-essentials skill. " +
        "Pass 'officialRef' (e.g. 'dql/dql-functions-string.md') to fetch a specific official function-reference doc " +
        "(use list_dql_official_references to discover them).",
      inputSchema: {
        topic: topicEnum
          .optional()
          .describe(
            "Which knowledge doc: playbook (default), reference (full), metrics, gotchas, " +
              "business-cases, k8s, official (Dynatrace dt-dql-essentials skill).",
          ),
        officialRef: z
          .string()
          .optional()
          .describe(
            "Relative path of an official dt-dql-essentials reference doc to fetch, e.g. " +
              "'dql/dql-functions-string.md' or 'optimization.md'. Takes precedence over topic. " +
              "Discover available paths with list_dql_official_references.",
          ),
      },
    },
    async ({ topic, officialRef }) => {
      // Specific official reference doc (with path-traversal protection).
      if (officialRef) {
        const rel = officialRef.replace(/^[/\\]+/, "");
        const abs = resolve(OFFICIAL_REFS_DIR, rel);
        const base = OFFICIAL_REFS_DIR.replace(new RegExp(`${sep}$`), "");
        if (abs !== base && !abs.startsWith(base + sep)) {
          return textResult(
            `Error: invalid officialRef path '${officialRef}' (must stay within the references directory).`,
          );
        }
        try {
          return textResult(await readFile(abs, "utf-8"));
        } catch (err) {
          return textResult(`Error: could not read official reference '${rel}': ${(err as Error).message}`);
        }
      }

      const resolved: Topic = (topic as Topic | undefined) ?? "playbook";
      const { file } = TOPIC_MAP[resolved];
      const filePath = `${KNOWLEDGE_DIR}${file}`;
      try {
        return textResult(await readFile(filePath, "utf-8"));
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
        "List the DQL knowledge topics fetchable via dql_reference (and one-line descriptions). " +
        "Includes both the project's own playbook/reference and the vendored official Dynatrace skill.",
      inputSchema: {},
    },
    async () => {
      const topics = Object.entries(TOPIC_MAP).map(([key, { desc }]) => ({ topic: key, description: desc }));
      return jsonResult({
        availableTopics: topics,
        note: "Use dql_reference({topic}) for a doc, or dql_reference({officialRef}) for a specific official function-reference file (see list_dql_official_references).",
      });
    },
  );

  // ── Tool: list_dql_official_references ────────────────────────────────────
  server.registerTool(
    "list_dql_official_references",
    {
      description:
        "List the reference docs inside the vendored official Dynatrace dt-dql-essentials skill " +
        "(Apache-2.0) — e.g. the per-category DQL function references. Fetch one with " +
        "dql_reference({ officialRef: '<path>' }).",
      inputSchema: {},
    },
    async () => {
      try {
        const entries = await readdir(OFFICIAL_REFS_DIR, { recursive: true, withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile() && e.name.endsWith(".md"))
          .map((e) => {
            const dir = (e.parentPath ?? (e as unknown as { path: string }).path ?? "").replace(/\/+$/, "");
            const full = dir ? `${dir}${sep}${e.name}` : e.name;
            return full.slice(OFFICIAL_REFS_DIR.replace(new RegExp(`${sep}$`), "").length + 1);
          })
          .sort();
        return jsonResult({ source: "vendor/dynatrace-for-ai/dt-dql-essentials (Apache-2.0)", references: files });
      } catch (err) {
        return jsonResult({ error: `could not list official references: ${(err as Error).message}` });
      }
    },
  );

  // ── Resources: dql:// ─────────────────────────────────────────────────────
  for (const [key, { file, desc }] of Object.entries(TOPIC_MAP)) {
    const uri = `dql://${key}`;
    const filePath = `${KNOWLEDGE_DIR}${file}`;
    server.resource(`dql-${key}`, uri, { description: desc, mimeType: "text/markdown" }, async (resourceUri) => {
      try {
        const text = await readFile(filePath, "utf-8");
        return { contents: [{ uri: resourceUri.href, mimeType: "text/markdown", text }] };
      } catch (err) {
        return {
          contents: [
            { uri: resourceUri.href, mimeType: "text/plain", text: `Error reading ${file}: ${(err as Error).message}` },
          ],
        };
      }
    });
  }
}

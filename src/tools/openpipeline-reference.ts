import { z } from "zod";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "../util/result.js";

const KNOWLEDGE_DIR = fileURLToPath(new URL("../../knowledge/openpipeline/", import.meta.url));

const TOPIC_MAP = {
  processors: {
    file: "openpipeline-processors.md",
    desc: "The 25 processor types, the 10 stages and which processors go in each, attribute shapes, and value-assignment modes (constant/field/multiValueConstant)",
  },
  scripting: {
    file: "openpipeline-scripting.md",
    desc: "The DQL-processor command subset (parse/fieldsAdd/… — NOT fetch/filter/summarize), the full scalar function catalog, and matcher grammar (matchesPhrase/matchesValue/and-or-not) — the two-language rule",
  },
  authoring: {
    file: "openpipeline-authoring.md",
    desc: "The object model (pipelines/routing/pipeline-groups per signal type), how a record flows, the safe read→dry-run→apply change recipe, and the gotchas (migration state, hyphenated schemaId, references by object id)",
  },
} as const;

type Topic = keyof typeof TOPIC_MAP;
const topicEnum = z.enum(Object.keys(TOPIC_MAP) as [Topic, ...Topic[]]);

export function registerOpenPipelineReferenceTools(server: McpServer): void {
  server.registerTool(
    "openpipeline_reference",
    {
      description:
        "Return embedded OpenPipeline authoring knowledge for building complex pipelines and changes via the " +
        "Settings 2.0 objects (builtin:openpipeline.<type>.pipelines / .routing / .pipeline-groups). Topics: " +
        "'processors' (25 processor types × 10 stages, attribute shapes, value assignment); " +
        "'scripting' (the dql-processor command subset + function catalog + matcher grammar — the two-language rule); " +
        "'authoring' (object model, record flow, safe read→dry-run→apply recipe, gotchas). " +
        "Consult before authoring a pipeline processor, a dql script, a matcher, a routing entry, or a pipeline group.",
      inputSchema: {
        topic: topicEnum.optional().describe("Which OpenPipeline knowledge doc to return (default: authoring)."),
      },
    },
    async ({ topic }) => {
      const t = (topic ?? "authoring") as Topic;
      const { file } = TOPIC_MAP[t];
      try {
        return textResult(await readFile(`${KNOWLEDGE_DIR}${file}`, "utf-8"));
      } catch (err) {
        return textResult(`Error: could not read OpenPipeline knowledge doc '${file}': ${(err as Error).message}`);
      }
    },
  );
}

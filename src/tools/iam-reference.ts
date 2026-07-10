import { z } from "zod";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult } from "../util/result.js";

const KNOWLEDGE_DIR = fileURLToPath(new URL("../../knowledge/iam/", import.meta.url));

const TOPIC_MAP = {
  "policies-and-boundaries": {
    file: "iam-policies-and-boundaries.md",
    desc: "IAM policy statement syntax, boundary syntax, permission vocabulary, and the create→bind loop",
  },
} as const;

type Topic = keyof typeof TOPIC_MAP;
const topicEnum = z.enum(Object.keys(TOPIC_MAP) as [Topic, ...Topic[]]);

export function registerIamReferenceTools(server: McpServer): void {
  server.registerTool(
    "iam_reference",
    {
      description:
        "Return embedded IAM authoring knowledge for policies, boundaries, and bindings: statement syntax " +
        "(ALLOW/DENY, service:resource:action, WHERE + operators, AND, DENY-override), boundary syntax " +
        "(field/operator/value, one condition per line, IN/startsWith, max 10, no AND), the permission " +
        "vocabulary, live-verified examples, and the create→bind loop. Consult before composing a " +
        "statementQuery or boundaryQuery for create_policy / create_policy_boundary.",
      inputSchema: {
        topic: topicEnum.optional().describe("Which IAM knowledge doc to return (default: policies-and-boundaries)."),
      },
    },
    async ({ topic }) => {
      const t = (topic ?? "policies-and-boundaries") as Topic;
      const { file } = TOPIC_MAP[t];
      try {
        return textResult(await readFile(`${KNOWLEDGE_DIR}${file}`, "utf-8"));
      } catch (err) {
        return textResult(`Error: could not read IAM knowledge doc '${file}': ${(err as Error).message}`);
      }
    },
  );
}

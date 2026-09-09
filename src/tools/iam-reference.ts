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
  "account-api-operations": {
    file: "account-api-operations.md",
    desc: "Account Management API operational reference: host/issuer, one-scope-per-token rules, endpoint quirks (no single-group GET, binding method), acts-as-user platform tokens, caller-only effective-permissions",
  },
} as const;

type Topic = keyof typeof TOPIC_MAP;
const topicEnum = z.enum(Object.keys(TOPIC_MAP) as [Topic, ...Topic[]]);

export function registerIamReferenceTools(server: McpServer): void {
  server.registerTool(
    "iam_reference",
    {
      description:
        "Return embedded IAM authoring & operational knowledge. Topics: 'policies-and-boundaries' " +
        "(statement syntax — ALLOW/DENY, service:resource:action, WHERE + operators, AND, DENY-override; " +
        "boundary syntax — field/operator/value, one per line, IN/startsWith, max 10, no AND; permission " +
        "vocabulary; the create→bind loop) — consult before composing a statementQuery/boundaryQuery. " +
        "'account-api-operations' (how the account tools connect: host/issuer, one-scope-per-token, endpoint " +
        "quirks, acts-as-user platform tokens, caller-only effective-permissions) — consult when wiring account " +
        "OAuth or debugging a 400/403/404 from an account tool.",
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

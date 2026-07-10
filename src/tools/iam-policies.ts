import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

/**
 * IAM policies + bindings — Account Management "Repo" API.
 *
 * Completes the IAM triad alongside boundaries:
 *   policy   = WHAT is allowed (permission statements, statementQuery)
 *   boundary = WHERE it applies (boundaryQuery)  ← see iam-boundaries.ts
 *   binding  = the ASSIGNMENT: policy → group(s), optionally limited by boundaries
 *
 * A policy/boundary is inert until a binding ties it to a group. All live at an
 * organisational LEVEL: account / environment / global. Requires the OAuth account
 * client (DT_OAUTH_CLIENT_ID / DT_OAUTH_CLIENT_SECRET / DT_ACCOUNT_URN).
 */

const OAUTH_NOTE =
  "Requires the account OAuth client config (DT_OAUTH_CLIENT_ID, DT_OAUTH_CLIENT_SECRET, DT_ACCOUNT_URN) " +
  "with the iam-policies-management scope.";

const LEVEL_TYPE = z
  .enum(["account", "environment", "global"])
  .optional()
  .describe("Organisational level (default 'account').");

const LEVEL_ID = z
  .string()
  .optional()
  .describe(
    "Level id. Defaults: account→account UUID (from DT_ACCOUNT_URN), global→'global'. Required for 'environment' (the environment id).",
  );

/** Resolve the /iam/v1/repo/{level}/{id} base for a resource, defaulting level id sensibly. */
function levelPath(deps: ToolDeps, resource: string, level?: string, levelId?: string): string {
  const account = deps.client.requireAccount();
  const lt = level ?? "account";
  let lid = levelId;
  if (!lid) {
    if (lt === "account") lid = account.accountUuid;
    else if (lt === "global") lid = "global";
    else throw new Error("levelId (the environment id) is required when levelType is 'environment'.");
  }
  return `/iam/v1/repo/${lt}/${encodeURIComponent(lid)}/${resource}`;
}

export function registerIamPolicyTools(server: McpServer, deps: ToolDeps): void {
  // ── Policies ────────────────────────────────────────────────────────────────
  server.registerTool(
    "list_policies",
    {
      description: "List IAM policies at an organisational level (Account Management Repo API). " + OAUTH_NOTE,
      inputSchema: { levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ levelType, levelId }) =>
      jsonResult(await deps.client.requireAccount().get(levelPath(deps, "policies", levelType, levelId))),
  );

  server.registerTool(
    "list_policies_aggregate",
    {
      description:
        "List IAM policies with overview details (name, description, category) at a level — the 'aggregate' view. " +
        OAUTH_NOTE,
      inputSchema: { levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ levelType, levelId }) =>
      jsonResult(await deps.client.requireAccount().get(levelPath(deps, "policies/aggregate", levelType, levelId))),
  );

  server.registerTool(
    "get_policy",
    {
      description:
        "Get an IAM policy by UUID at a level (Account Management Repo API). Returns statementQuery + parsed statements. " +
        OAUTH_NOTE,
      inputSchema: { policyUuid: z.string(), levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ policyUuid, levelType, levelId }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(`${levelPath(deps, "policies", levelType, levelId)}/${encodeURIComponent(policyUuid)}`),
      ),
  );

  server.registerTool(
    "create_policy",
    {
      description:
        "Create an IAM policy (WRITE, Account Management Repo API). The permissions are expressed as a " +
        "statementQuery, e.g. 'ALLOW storage:events:read, storage:logs:read;' or " +
        "'ALLOW storage:events:read WHERE storage:k8s.namespace.name = \"apps\";'. " +
        OAUTH_NOTE,
      inputSchema: {
        name: z.string().describe("Policy name."),
        statementQuery: z
          .string()
          .describe(
            "Policy statement(s) in IAM policy syntax, e.g. 'ALLOW storage:events:read;'. Statements end with ';'.",
          ),
        description: z.string().optional().describe("Optional description."),
        tags: z.array(z.string()).optional().describe("Optional tags."),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ name, statementQuery, description, tags, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .post(levelPath(deps, "policies", levelType, levelId), { name, statementQuery, description, tags }),
      );
    },
  );

  server.registerTool(
    "update_policy",
    {
      description:
        "Update (replace) an IAM policy by UUID (WRITE, Account Management Repo API). name + statementQuery are overwritten. " +
        OAUTH_NOTE,
      inputSchema: {
        policyUuid: z.string(),
        name: z.string().describe("Policy name."),
        statementQuery: z.string().describe("Full replacement statement query."),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ policyUuid, name, statementQuery, description, tags, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .put(`${levelPath(deps, "policies", levelType, levelId)}/${encodeURIComponent(policyUuid)}`, {
            name,
            statementQuery,
            description,
            tags,
          }),
      );
    },
  );

  server.registerTool(
    "delete_policy",
    {
      description: "Delete an IAM policy by UUID (WRITE, destructive, Account Management Repo API). " + OAUTH_NOTE,
      inputSchema: { policyUuid: z.string(), levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ policyUuid, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .del(`${levelPath(deps, "policies", levelType, levelId)}/${encodeURIComponent(policyUuid)}`),
      );
    },
  );

  // ── Bindings (policy → groups, optionally limited by boundaries) ──────────────
  server.registerTool(
    "list_policy_bindings",
    {
      description:
        "List all policy bindings at a level (Account Management Repo API) — which policies are bound to which groups. " +
        OAUTH_NOTE,
      inputSchema: { levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ levelType, levelId }) =>
      jsonResult(await deps.client.requireAccount().get(levelPath(deps, "bindings", levelType, levelId))),
  );

  server.registerTool(
    "get_group_policy_bindings",
    {
      description:
        "List the policies bound to a specific group at a level (Account Management Repo API). " + OAUTH_NOTE,
      inputSchema: { groupUuid: z.string(), levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ groupUuid, levelType, levelId }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(`${levelPath(deps, "bindings/groups", levelType, levelId)}/${encodeURIComponent(groupUuid)}`),
      ),
  );

  server.registerTool(
    "bind_policy_to_groups",
    {
      description:
        "Bind a policy to one or more groups at a level (WRITE, idempotent replace, Account Management Repo API). " +
        "This is the step that makes a policy take effect. Optionally restrict the binding with boundary UUIDs " +
        "(from list_policy_boundaries) — the group then gets the policy ONLY within those boundaries. " +
        "Sets the full group/boundary set for the policy (replaces existing). " +
        OAUTH_NOTE,
      inputSchema: {
        policyUuid: z.string().describe("The policy to bind."),
        groups: z.array(z.string()).describe("Group UUIDs to bind the policy to (replaces the current set)."),
        boundaries: z
          .array(z.string())
          .optional()
          .describe("Optional boundary UUIDs restricting where the binding applies."),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ policyUuid, groups, boundaries, levelType, levelId }) => {
      requireWrites(deps.config);
      const body: Record<string, unknown> = { policyUuid, groups };
      if (boundaries?.length) body.boundaries = boundaries;
      return jsonResult(
        await deps.client
          .requireAccount()
          .put(`${levelPath(deps, "bindings", levelType, levelId)}/${encodeURIComponent(policyUuid)}`, body),
      );
    },
  );

  server.registerTool(
    "unbind_policy_from_group",
    {
      description:
        "Remove a policy binding from a single group at a level (WRITE, Account Management Repo API). " + OAUTH_NOTE,
      inputSchema: {
        policyUuid: z.string(),
        groupUuid: z.string(),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ policyUuid, groupUuid, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .del(
            `${levelPath(deps, "bindings", levelType, levelId)}/${encodeURIComponent(policyUuid)}/${encodeURIComponent(groupUuid)}`,
          ),
      );
    },
  );
}

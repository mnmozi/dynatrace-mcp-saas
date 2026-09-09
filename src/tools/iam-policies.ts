import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";
import { OAUTH_NOTE, LEVEL_TYPE, LEVEL_ID, repoLevelPath } from "../util/account-iam.js";

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

/** Resolve the /iam/v1/repo/{level}/{id}/{resource} base, defaulting level id sensibly. */
const levelPath = repoLevelPath;

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
    "set_group_policies",
    {
      description:
        "Set the policies bound to a GROUP at a level (WRITE, Account Management Repo API). " +
        "PUT /bindings/groups/{groupUuid} with {policyUuids} — this REPLACES the group's bindings: " +
        "any policy not present in the request is discarded (pass the full desired set). " +
        "This is the documented, reliable way to assign policies to a group. Returns 204. " +
        OAUTH_NOTE,
      inputSchema: {
        groupUuid: z.string().describe("The group whose policy bindings are being set."),
        policyUuids: z
          .array(z.string())
          .describe("Full desired set of policy UUIDs for this group (omitted policies are unbound)."),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ groupUuid, policyUuids, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .put(`${levelPath(deps, "bindings/groups", levelType, levelId)}/${encodeURIComponent(groupUuid)}`, {
            policyUuids,
          }),
      );
    },
  );

  server.registerTool(
    "bind_policy_to_groups",
    {
      description:
        "Bind a policy to one or more groups at a level (WRITE, Account Management Repo API). " +
        "POST /bindings/{policyUuid} — the policy-centric variant; use set_group_policies for the " +
        "documented group-centric assignment. " +
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
      // "Update bindings of a policy" is a POST (a PUT here 404s — live-verified).
      const body: Record<string, unknown> = { policyUuid, groups };
      if (boundaries?.length) body.boundaries = boundaries;
      return jsonResult(
        await deps.client
          .requireAccount()
          .post(`${levelPath(deps, "bindings", levelType, levelId)}/${encodeURIComponent(policyUuid)}`, body),
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

  server.registerTool(
    "rebind_policy_boundaries",
    {
      description:
        "Change the boundaries on an EXISTING policy→group binding (WRITE, Account Management Repo API). " +
        "Bindings are create-only — you cannot edit their boundaries in place (POST/PUT on an existing binding " +
        "400s 'binding already exists'). So this does the documented delete-and-recreate: unbind the group " +
        "(DELETE /bindings/{policyUuid}/{groupUuid}) then re-bind it with the NEW boundary set " +
        "(POST /bindings/{policyUuid}). Composes two live-verified calls — no new endpoint. " +
        "Pass boundaries:[] to strip all boundaries (make the binding unconditional). Scope: single (policy, " +
        "group) pair; call once per group. If the unbind succeeds but the re-bind fails, the group is left " +
        "UNBOUND — the response surfaces both steps so you can see and recover. " +
        OAUTH_NOTE,
      inputSchema: {
        policyUuid: z.string().describe("The bound policy."),
        groupUuid: z.string().describe("The group whose binding boundaries are being replaced."),
        boundaries: z
          .array(z.string())
          .describe("The NEW full boundary UUID set for the binding (empty array = unconditional)."),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ policyUuid, groupUuid, boundaries, levelType, levelId }) => {
      requireWrites(deps.config);
      const account = deps.client.requireAccount();
      const base = levelPath(deps, "bindings", levelType, levelId);
      const pid = encodeURIComponent(policyUuid);

      // Step 1: unbind (DELETE the existing (policy, group) binding).
      const unbind = await account.del(`${base}/${pid}/${encodeURIComponent(groupUuid)}`);

      // Step 2: re-bind the same group with the new boundary set. If this throws, the
      // group is now unbound — surface that explicitly rather than swallowing it.
      const body: Record<string, unknown> = { policyUuid, groups: [groupUuid] };
      if (boundaries.length) body.boundaries = boundaries;
      try {
        const bind = await account.post(`${base}/${pid}`, body);
        return jsonResult({ rebound: true, policyUuid, groupUuid, boundaries, steps: { unbind, bind } });
      } catch (err) {
        return jsonResult({
          rebound: false,
          policyUuid,
          groupUuid,
          warning:
            "Unbind succeeded but re-bind FAILED — the group is currently UNBOUND from this policy. " +
            "Re-run bind_policy_to_groups to restore it.",
          error: (err as Error).message,
          steps: { unbind },
        });
      }
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

/**
 * Effective-permission inspection.
 *
 * Two complementary views, because Dynatrace exposes no account-level "resolve for
 * user X" endpoint (probed: every /iam/v1/accounts/{uuid}/users/{id}/permissions
 * variant 404s; /groups/{g}/permissions returns only LEGACY account roles, not IAM
 * policy permissions):
 *
 *  1. resolve_effective_permissions — the platform resolver
 *     (POST /platform/management/v1/effective-permissions:resolve). Answers "can the
 *     CALLING identity do X", optionally under context key-values. Caller-only by
 *     design: there is no user parameter.
 *
 *  2. describe_group_permissions — composed, deterministic resolution from the authored
 *     objects: group → members → policy bindings → each policy's statementQuery → each
 *     attached boundary's boundaryQuery. This is API-derived ground truth for auditing,
 *     and is what you diff against the UI resolver's answer.
 */

const IDM_SCOPE = "account-idm-read";

interface PolicyBinding {
  policyUuid: string;
  groups?: string[];
  boundaries?: string[];
}
interface BindingsResponse {
  policyBindings?: PolicyBinding[];
}
interface Policy {
  uuid?: string;
  name?: string;
  description?: string;
  statementQuery?: string;
}
interface Boundary {
  uuid?: string;
  name?: string;
  boundaryQuery?: string;
}

export function registerPermissionTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "resolve_effective_permissions",
    {
      description:
        "Resolve whether the CALLING identity (this MCP's platform token) has the given permissions " +
        "(POST /platform/management/v1/effective-permissions:resolve). Returns granted true/false/condition " +
        "per permission. Optionally supply context key-values (e.g. storage:k8s.cluster.name=mycluster) to " +
        "evaluate conditional grants. NOTE: caller-only — the API takes no user parameter, so this cannot " +
        "answer 'what can user X do'. For that, use describe_group_permissions.",
      inputSchema: {
        permissions: z
          .array(z.string())
          .describe("Permissions to resolve, e.g. ['storage:logs:read','storage:bizevents:read']."),
        context: z
          .record(z.string())
          .optional()
          .describe("Optional context key-values for conditional grants, e.g. { 'storage:k8s.cluster.name': 'prod' }."),
      },
    },
    async ({ permissions, context }) => {
      const body = {
        permissions: permissions.map((permission) => ({
          permission,
          ...(context ? { context: Object.entries(context).map(([key, value]) => ({ key, value })) } : {}),
        })),
      };
      return jsonResult(await deps.client.platform.post("/platform/management/v1/effective-permissions:resolve", body));
    },
  );

  server.registerTool(
    "describe_group_permissions",
    {
      description:
        "Compose a group's FULL effective IAM permission set from the authored objects (deterministic, API-derived). " +
        "Walks: group → members → policy bindings at the level → each bound policy's statementQuery → each attached " +
        "boundary's boundaryQuery. Use this to audit what a group (and therefore its members) actually grants, and to " +
        "diff against the Account Management UI's resolver. Read-only.",
      inputSchema: {
        groupUuid: z.string().describe("The group to describe (from list_account_groups)."),
        levelType: z
          .enum(["account", "environment", "global"])
          .optional()
          .describe("Binding level (default 'account')."),
        levelId: z.string().optional().describe("Level id; defaults to the account UUID (or 'global')."),
        includeMembers: z.boolean().optional().describe("Include the group's user members (default true)."),
      },
    },
    async ({ groupUuid, levelType, levelId, includeMembers }) => {
      const account = deps.client.requireAccount();
      const lt = levelType ?? "account";
      const lid = levelId ?? (lt === "global" ? "global" : account.accountUuid);
      const repo = `/iam/v1/repo/${lt}/${encodeURIComponent(lid)}`;
      const acct = `/iam/v1/accounts/${encodeURIComponent(account.accountUuid)}`;

      const group = await account.get<Record<string, unknown>>(
        `${acct}/groups/${encodeURIComponent(groupUuid)}`,
        undefined,
        IDM_SCOPE,
      );

      const members =
        includeMembers === false
          ? undefined
          : await account.get<unknown>(`${acct}/groups/${encodeURIComponent(groupUuid)}/users`, undefined, IDM_SCOPE);

      // Bindings at the level; keep only those that include this group.
      const bindings = await account.get<BindingsResponse>(`${repo}/bindings`);
      const mine = (bindings.policyBindings ?? []).filter((b) => (b.groups ?? []).includes(groupUuid));

      // Resolve each bound policy + its attached boundaries.
      const resolved = [];
      for (const b of mine) {
        let policy: Policy | { error: string };
        try {
          policy = await account.get<Policy>(`${repo}/policies/${encodeURIComponent(b.policyUuid)}`);
        } catch (err) {
          // Policies bound at a lower level may live at global — surface rather than fail.
          policy = { error: `could not fetch policy ${b.policyUuid}: ${(err as Error).message}` };
        }

        const boundaries: Array<Boundary | { error: string }> = [];
        for (const bu of b.boundaries ?? []) {
          try {
            boundaries.push(await account.get<Boundary>(`${repo}/boundaries/${encodeURIComponent(bu)}`));
          } catch (err) {
            boundaries.push({ error: `could not fetch boundary ${bu}: ${(err as Error).message}` });
          }
        }
        resolved.push({ policyUuid: b.policyUuid, policy, boundaries });
      }

      return jsonResult({
        level: { levelType: lt, levelId: lid },
        group,
        members,
        bindingCount: resolved.length,
        bindings: resolved,
        note:
          "Composed from authored objects (bindings → policies → boundaries). A policy with no boundaries is " +
          "unconditional at this level; boundaries are evaluated per boundary (effective statements are computed " +
          "separately for each).",
      });
    },
  );
}

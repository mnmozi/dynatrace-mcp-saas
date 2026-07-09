import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

/**
 * IAM policy boundaries — Account Management API (api.dynatrace.com).
 *
 * Boundaries restrict WHERE a policy binding applies (e.g. limit a group's
 * policy to specific management zones or environments) via a boundary query.
 * They live at the ACCOUNT level and require the OAuth client credentials
 * (DT_OAUTH_CLIENT_ID / DT_OAUTH_CLIENT_SECRET / DT_ACCOUNT_URN) — the tenant
 * platform/classic tokens cannot reach this API.
 */

const OAUTH_NOTE =
  "Requires the account OAuth client config (DT_OAUTH_CLIENT_ID, DT_OAUTH_CLIENT_SECRET, DT_ACCOUNT_URN) " +
  "with the iam-policies-management scope.";

const LEVEL_TYPE = z.enum(["account", "environment"]).optional().describe("Organisational level (default 'account').");

const LEVEL_ID = z
  .string()
  .optional()
  .describe("Level UUID/id. Defaults to the account UUID derived from DT_ACCOUNT_URN.");

function repoPath(deps: ToolDeps, levelType?: string, levelId?: string): string {
  const account = deps.client.requireAccount();
  const lt = levelType ?? "account";
  const lid = levelId ?? account.accountUuid;
  return `/iam/v1/repo/${encodeURIComponent(lt)}/${encodeURIComponent(lid)}/boundaries`;
}

export function registerIamBoundaryTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_policy_boundaries",
    {
      description: "List IAM policy boundaries at an organisational level (Account Management API). " + OAUTH_NOTE,
      inputSchema: { levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ levelType, levelId }) =>
      jsonResult(await deps.client.requireAccount().get(repoPath(deps, levelType, levelId))),
  );

  server.registerTool(
    "get_policy_boundary",
    {
      description: "Get an IAM policy boundary by UUID (Account Management API). " + OAUTH_NOTE,
      inputSchema: { boundaryUuid: z.string(), levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ boundaryUuid, levelType, levelId }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(`${repoPath(deps, levelType, levelId)}/${encodeURIComponent(boundaryUuid)}`),
      ),
  );

  server.registerTool(
    "create_policy_boundary",
    {
      description:
        "Create an IAM policy boundary (WRITE, Account Management API). A boundary restricts where policy " +
        "bindings apply via a boundary query, e.g. " +
        "'environment:management-zone startsWith \"team-a\";' or 'environment(abc12345);'. " +
        OAUTH_NOTE,
      inputSchema: {
        name: z.string().describe("Boundary name."),
        boundaryQuery: z
          .string()
          .describe(
            "Boundary query (Dynatrace policy boundary syntax), e.g. " +
              "'environment:management-zone = \"MZ-A\";'. Statements end with ';'.",
          ),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ name, boundaryQuery, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.requireAccount().post(repoPath(deps, levelType, levelId), { name, boundaryQuery }),
      );
    },
  );

  server.registerTool(
    "update_policy_boundary",
    {
      description:
        "Update (replace) an IAM policy boundary by UUID (WRITE, Account Management API). " +
        "Both name and boundaryQuery are overwritten. " +
        OAUTH_NOTE,
      inputSchema: {
        boundaryUuid: z.string(),
        name: z.string().describe("Boundary name."),
        boundaryQuery: z.string().describe("Full replacement boundary query."),
        levelType: LEVEL_TYPE,
        levelId: LEVEL_ID,
      },
    },
    async ({ boundaryUuid, name, boundaryQuery, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .put(`${repoPath(deps, levelType, levelId)}/${encodeURIComponent(boundaryUuid)}`, {
            name,
            boundaryQuery,
          }),
      );
    },
  );

  server.registerTool(
    "delete_policy_boundary",
    {
      description: "Delete an IAM policy boundary by UUID (WRITE, destructive, Account Management API). " + OAUTH_NOTE,
      inputSchema: { boundaryUuid: z.string(), levelType: LEVEL_TYPE, levelId: LEVEL_ID },
    },
    async ({ boundaryUuid, levelType, levelId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .del(`${repoPath(deps, levelType, levelId)}/${encodeURIComponent(boundaryUuid)}`),
      );
    },
  );
}

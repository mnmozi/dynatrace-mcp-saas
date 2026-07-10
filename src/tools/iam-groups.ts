import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";
import { findAccountGroup } from "../util/account-groups.js";

/**
 * Account groups — Account Management IDM API (/iam/v1/accounts/{uuid}/groups).
 *
 * SEPARATE from the policy/boundary "repo" API: groups use the account IDM API and
 * DIFFERENT OAuth scopes — account-idm-read for reads, account-idm-write for writes.
 * (The OAuth client must be created with those scopes; write is refused with
 * 400 invalid_request otherwise.) Reuses the same OAuth account client.
 */

const READ_SCOPE = "account-idm-read";
const WRITE_SCOPE = "account-idm-write";

const READ_NOTE =
  "Requires the account OAuth client (DT_OAUTH_CLIENT_ID/SECRET, DT_ACCOUNT_URN) with the account-idm-read scope.";
const WRITE_NOTE =
  "WRITE. Requires the account OAuth client with the account-idm-write scope (the client must be created with it).";

function groupsBase(deps: ToolDeps): string {
  const account = deps.client.requireAccount();
  return `/iam/v1/accounts/${encodeURIComponent(account.accountUuid)}/groups`;
}

export function registerIamGroupTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_account_groups",
    {
      description: "List account groups (Account Management IDM API). " + READ_NOTE,
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.requireAccount().get(groupsBase(deps), undefined, READ_SCOPE)),
  );

  server.registerTool(
    "get_account_group",
    {
      description:
        "Get an account group by UUID (Account Management IDM API). NOTE: the API has no single-group GET " +
        "(/groups/{uuid} 404s), so this resolves the group from the group list. " +
        READ_NOTE,
      inputSchema: { groupUuid: z.string() },
    },
    async ({ groupUuid }) => jsonResult(await findAccountGroup(deps.client.requireAccount(), groupUuid)),
  );

  server.registerTool(
    "create_account_group",
    {
      description:
        "Create an account group (Account Management IDM API). The create endpoint accepts an array of groups; " +
        "this tool wraps a single group. Bind policies to the returned group UUID with bind_policy_to_groups. " +
        WRITE_NOTE,
      inputSchema: {
        name: z.string().describe("Group name."),
        description: z.string().optional().describe("Optional description."),
      },
    },
    async ({ name, description }) => {
      requireWrites(deps.config);
      // The account IDM create endpoint takes an ARRAY of group definitions.
      return jsonResult(
        await deps.client.requireAccount().post(groupsBase(deps), [{ name, description }], undefined, WRITE_SCOPE),
      );
    },
  );

  server.registerTool(
    "update_account_group",
    {
      description: "Update an account group by UUID (Account Management IDM API). " + WRITE_NOTE,
      inputSchema: {
        groupUuid: z.string(),
        name: z.string().describe("Group name."),
        description: z.string().optional().describe("Optional description."),
      },
    },
    async ({ groupUuid, name, description }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .put(`${groupsBase(deps)}/${encodeURIComponent(groupUuid)}`, { name, description }, undefined, WRITE_SCOPE),
      );
    },
  );

  server.registerTool(
    "delete_account_group",
    {
      description: "Delete an account group by UUID (Account Management IDM API, destructive). " + WRITE_NOTE,
      inputSchema: { groupUuid: z.string() },
    },
    async ({ groupUuid }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .del(`${groupsBase(deps)}/${encodeURIComponent(groupUuid)}`, undefined, WRITE_SCOPE),
      );
    },
  );
}

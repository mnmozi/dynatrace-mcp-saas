import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";
import { ACCOUNT_SCOPES, ACCOUNT_NOTES, accountBase } from "../util/account-iam.js";

/**
 * Account users & group membership — Account Management IDM API.
 *
 * NOTE: the platform-host IAM endpoints (/platform/iam/v1/organizational-levels/...)
 * 403 without an account-scoped platform token carrying iam:users:read. This API is the
 * working door: same OAuth account client, account-idm-read scope. Live-verified.
 *
 * Membership is USER-centric: the user resource carries `groups: [{uuid, ...}]`, and you
 * change membership on the user (POST /users/{email} to add, DELETE /groups/{g}/users/{email}
 * to remove) — NOT via a group-side "add member" endpoint (there isn't one). The read shape
 * is live-verified; the write endpoints follow the documented Account Management API and are
 * write-gated — confirm once against a throwaway group before trusting in automation.
 */

const READ_SCOPE = ACCOUNT_SCOPES.idmRead;
const READ_NOTE = ACCOUNT_NOTES.idmRead;
const WRITE_SCOPE = ACCOUNT_SCOPES.idmWrite;
const WRITE_NOTE = ACCOUNT_NOTES.idmWrite;

export function registerIamUserTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_account_users",
    {
      description: "List all users on the account (Account Management IDM API). Read-only. " + READ_NOTE,
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.requireAccount().get(`${accountBase(deps)}/users`, undefined, READ_SCOPE)),
  );

  server.registerTool(
    "get_account_user",
    {
      description:
        "Get an account user by email, including their group memberships (Account Management IDM API). Read-only. " +
        READ_NOTE,
      inputSchema: { email: z.string().describe("The user's email address.") },
    },
    async ({ email }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(`${accountBase(deps)}/users/${encodeURIComponent(email)}`, undefined, READ_SCOPE),
      ),
  );

  server.registerTool(
    "list_group_members",
    {
      description:
        "List the users who are members of an account group (Account Management IDM API). Read-only. " +
        "Use this to audit who a policy binding actually reaches — the platform-host IAM endpoints 403 " +
        "without an account-scoped platform token. " +
        READ_NOTE,
      inputSchema: { groupUuid: z.string().describe("The group UUID (from list_account_groups).") },
    },
    async ({ groupUuid }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(`${accountBase(deps)}/groups/${encodeURIComponent(groupUuid)}/users`, undefined, READ_SCOPE),
      ),
  );

  server.registerTool(
    "add_user_to_groups",
    {
      description:
        "Add an account user to one or more groups (WRITE, Account Management IDM API). " +
        "POST /iam/v1/accounts/{uuid}/users/{email} with an array of group UUIDs — ADDITIVE (the user keeps " +
        "existing groups). This is the account-API path for group membership; there is no group-side " +
        "'add member' endpoint. Get UUIDs from list_account_groups; verify with get_account_user afterward. " +
        WRITE_NOTE,
      inputSchema: {
        email: z.string().describe("The user's email address."),
        groupUuids: z.array(z.string()).min(1).describe("Group UUIDs to add the user to (additive)."),
      },
    },
    async ({ email, groupUuids }) => {
      requireWrites(deps.config);
      // The add endpoint takes a bare JSON array of group UUIDs.
      return jsonResult(
        await deps.client
          .requireAccount()
          .post(`${accountBase(deps)}/users/${encodeURIComponent(email)}`, groupUuids, undefined, WRITE_SCOPE),
      );
    },
  );

  server.registerTool(
    "remove_user_from_group",
    {
      description:
        "Remove an account user from a single group (WRITE, Account Management IDM API). " +
        "DELETE /iam/v1/accounts/{uuid}/groups/{groupUuid}/users/{email}. Does not delete the user or the " +
        "group — only the membership. " +
        WRITE_NOTE,
      inputSchema: {
        email: z.string().describe("The user's email address."),
        groupUuid: z.string().describe("The group UUID to remove the user from."),
      },
    },
    async ({ email, groupUuid }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .del(
            `${accountBase(deps)}/groups/${encodeURIComponent(groupUuid)}/users/${encodeURIComponent(email)}`,
            undefined,
            WRITE_SCOPE,
          ),
      );
    },
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

/**
 * Account users & group membership — Account Management IDM API.
 *
 * NOTE: the platform-host IAM endpoints (/platform/iam/v1/organizational-levels/...)
 * 403 without an account-scoped platform token carrying iam:users:read. This API is the
 * working door: same OAuth account client, account-idm-read scope. Live-verified.
 *
 * Read-only for now — membership writes exist but their request shapes are not yet
 * verified against the live API (see the bindings lesson: guessed write shapes 404'd).
 */

const READ_SCOPE = "account-idm-read";
const READ_NOTE =
  "Requires the account OAuth client (DT_OAUTH_CLIENT_ID/SECRET, DT_ACCOUNT_URN) with the account-idm-read scope.";

function accountBase(deps: ToolDeps): string {
  const account = deps.client.requireAccount();
  return `/iam/v1/accounts/${encodeURIComponent(account.accountUuid)}`;
}

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
}

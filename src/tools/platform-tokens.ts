import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

/**
 * Account Platform Tokens API (/iam/v1/accounts/{uuid}/platform-tokens).
 *
 * Create/list/delete platform tokens for the account. The create body's `userUuid`
 * designates the OWNER — so an account admin can mint a token that acts AS another
 * user, enforcing THAT user's IAM permissions/boundaries. This is the clean way to
 * test a user's effective access without them logging in.
 *
 * WRITE ops require the account-idm-write scope. Handle returned token values as
 * secrets — they are shown once.
 */

const READ_SCOPE = "account-idm-read";
const WRITE_SCOPE = "account-idm-write";
const READ_NOTE = "Requires the account OAuth client with account-idm-read.";
const WRITE_NOTE = "WRITE. Requires the account OAuth client with account-idm-write.";

function base(deps: ToolDeps): string {
  const account = deps.client.requireAccount();
  return `/iam/v1/accounts/${encodeURIComponent(account.accountUuid)}/platform-tokens`;
}

export function registerPlatformTokenTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_platform_tokens",
    {
      description: "List the account's platform tokens (metadata only, no secrets). " + READ_NOTE,
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.requireAccount().get(base(deps), undefined, READ_SCOPE)),
  );

  server.registerTool(
    "create_platform_token",
    {
      description:
        "Create a platform token owned by a specific account user (Account Platform Tokens API). " +
        "The token ACTS AS that user (its `userUuid`), enforcing that user's IAM permissions and boundaries — " +
        "ideal for testing a user's effective access without them logging in. The response contains the token " +
        "SECRET (shown once) — treat it as a credential. " +
        WRITE_NOTE,
      inputSchema: {
        name: z.string().describe("Token name."),
        userUuid: z
          .string()
          .describe("The account user UUID the token belongs to (from get_account_user / list_account_users)."),
        scopes: z
          .array(z.string())
          .describe(
            "Token scopes. For an access test, grant BROADLY (e.g. storage:bizevents:read, storage:buckets:read, " +
              "storage:logs:read, platform-management:effective-permissions:resolve) so any denial is attributable " +
              "to the user's IAM policy, not a missing scope.",
          ),
        expirationDate: z
          .string()
          .describe("ISO-8601 expiry, e.g. '2026-07-11T00:00:00.000Z'. Use a short expiry for test tokens."),
        resources: z
          .array(z.string())
          .optional()
          .describe("Optional resource restrictions (string array); omit for account-wide."),
        tags: z.array(z.string()).optional().describe("Optional tags."),
      },
    },
    async ({ name, userUuid, scopes, expirationDate, resources, tags }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client
          .requireAccount()
          .post(
            base(deps),
            { name, userUuid, scope: scopes, resource: resources ?? [], tags: tags ?? [], expirationDate },
            undefined,
            WRITE_SCOPE,
          ),
      );
    },
  );

  server.registerTool(
    "delete_platform_token",
    {
      description:
        "Delete (revoke) a platform token by id (Account Platform Tokens API, destructive). " +
        "Revoke test tokens as soon as the test is done. " +
        WRITE_NOTE,
      inputSchema: { tokenId: z.string().describe("The platform token id to revoke.") },
    },
    async ({ tokenId }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.requireAccount().del(`${base(deps)}/${encodeURIComponent(tokenId)}`, undefined, WRITE_SCOPE),
      );
    },
  );
}

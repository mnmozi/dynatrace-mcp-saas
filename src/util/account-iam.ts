import { z } from "zod";
import type { ToolDeps } from "../tools/registry.js";

/**
 * Shared building blocks for the Account Management "Repo" API IAM tools
 * (policies, boundaries, bindings). These all live at an organisational LEVEL
 * (account / environment / global) under /iam/v1/repo/{level}/{levelId}/... and
 * require the OAuth account client. Previously each tool module hand-copied the
 * LEVEL_TYPE/LEVEL_ID schemas and the level-path resolver, which had already
 * drifted between files — this is the single source of truth.
 */

export const OAUTH_NOTE =
  "Requires the account OAuth client config (DT_OAUTH_CLIENT_ID, DT_OAUTH_CLIENT_SECRET, DT_ACCOUNT_URN) " +
  "with the iam-policies-management scope.";

/**
 * The per-API OAuth scopes for the Account Management surface. Each account API
 * needs its own scope (the SSO rejects multi-scope token requests), so tokens are
 * fetched/cached per scope by the AccountClient. One source of truth for the
 * literals that were previously hand-copied into every account tool module.
 */
export const ACCOUNT_SCOPES = {
  /** Policies / boundaries / bindings (the "repo" API). */
  policies: "iam-policies-management",
  /** IDM reads: groups, users, memberships, platform-token listing. */
  idmRead: "account-idm-read",
  /** IDM writes: create/update/delete groups, create/delete platform tokens. */
  idmWrite: "account-idm-write",
  /** Usage & cost (subscriptions) reads. */
  uacRead: "account-uac-read",
} as const;

const oauthClientPrefix = "Requires the account OAuth client (DT_OAUTH_CLIENT_ID/SECRET, DT_ACCOUNT_URN)";

/** Standard tool-description notes, one per scope — keeps the wording consistent. */
export const ACCOUNT_NOTES = {
  idmRead: `${oauthClientPrefix} with the account-idm-read scope.`,
  idmWrite: "WRITE. Requires the account OAuth client with the account-idm-write scope (the client must be created with it).",
  uacRead: `${oauthClientPrefix} with the account-uac-read scope.`,
} as const;

/** The /iam/v1/accounts/{accountUuid} IDM base for the configured account. */
export function accountBase(deps: ToolDeps): string {
  const account = deps.client.requireAccount();
  return `/iam/v1/accounts/${encodeURIComponent(account.accountUuid)}`;
}

export const LEVEL_TYPE = z
  .enum(["account", "environment", "global"])
  .optional()
  .describe("Organisational level (default 'account').");

export const LEVEL_ID = z
  .string()
  .optional()
  .describe(
    "Level id. Defaults: account→account UUID (from DT_ACCOUNT_URN), global→'global'. Required for 'environment' (the environment id).",
  );

/**
 * Resolve the /iam/v1/repo/{level}/{levelId}/{resource} path for a repo resource,
 * defaulting the level id sensibly (account→account UUID, global→"global"), and
 * throwing a clear error when levelType='environment' is passed without a levelId.
 */
export function repoLevelPath(deps: ToolDeps, resource: string, level?: string, levelId?: string): string {
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

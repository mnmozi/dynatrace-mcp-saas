import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import type { QueryParams } from "../types.js";
import { jsonResult } from "../util/result.js";

/**
 * Cost & consumption — Dynatrace Platform Subscription API (/sub/v2/accounts/{uuid}/…).
 *
 * Read-only. Uses the OAuth account client with the account-uac-read scope
 * ("read access for usage and consumption resources") — distinct from the repo
 * (iam-policies-management) and IDM (account-idm-*) scopes. The OAuth client must
 * be created with account-uac-read; otherwise the SSO refuses the token.
 */

const UAC_SCOPE = "account-uac-read";
const NOTE =
  "Requires the account OAuth client (DT_OAUTH_CLIENT_ID/SECRET, DT_ACCOUNT_URN) with the account-uac-read scope.";

function subsBase(deps: ToolDeps): string {
  const account = deps.client.requireAccount();
  return `/sub/v2/accounts/${encodeURIComponent(account.accountUuid)}/subscriptions`;
}

// Cost/usage endpoints filter by comma-separated id lists (OpenAPI form/non-explode).
const FILTERS = {
  environmentIds: z.array(z.string()).optional().describe("Filter to these environment ids."),
  capabilityKeys: z.array(z.string()).optional().describe("Filter to these capability keys."),
  clusterIds: z.array(z.string()).optional().describe("Filter to these Managed cluster ids."),
};

function filterQuery(f: { environmentIds?: string[]; capabilityKeys?: string[]; clusterIds?: string[] }): QueryParams {
  const q: QueryParams = {};
  if (f.environmentIds?.length) q.environmentIds = f.environmentIds.join(",");
  if (f.capabilityKeys?.length) q.capabilityKeys = f.capabilityKeys.join(",");
  if (f.clusterIds?.length) q.clusterIds = f.clusterIds.join(",");
  return q;
}

export function registerCostTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_subscriptions",
    {
      description: "List the account's Dynatrace Platform Subscriptions (cost/consumption). Read-only. " + NOTE,
      inputSchema: {},
    },
    async () => jsonResult(await deps.client.requireAccount().get(subsBase(deps), undefined, UAC_SCOPE)),
  );

  server.registerTool(
    "get_subscription",
    {
      description: "Get a subscription by UUID (Platform Subscription API). Read-only. " + NOTE,
      inputSchema: { subscriptionUuid: z.string() },
    },
    async ({ subscriptionUuid }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(`${subsBase(deps)}/${encodeURIComponent(subscriptionUuid)}`, undefined, UAC_SCOPE),
      ),
  );

  server.registerTool(
    "get_subscription_cost",
    {
      description:
        "Get the COST breakdown for a subscription (Platform Subscription API). Read-only. " +
        "Optionally filter by environment / capability / cluster. " +
        NOTE,
      inputSchema: { subscriptionUuid: z.string(), ...FILTERS },
    },
    async ({ subscriptionUuid, environmentIds, capabilityKeys, clusterIds }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(
            `${subsBase(deps)}/${encodeURIComponent(subscriptionUuid)}/cost`,
            filterQuery({ environmentIds, capabilityKeys, clusterIds }),
            UAC_SCOPE,
          ),
      ),
  );

  server.registerTool(
    "get_subscription_usage",
    {
      description:
        "Get the USAGE/consumption breakdown for a subscription (Platform Subscription API). Read-only. " +
        "Optionally filter by environment / capability / cluster. " +
        NOTE,
      inputSchema: { subscriptionUuid: z.string(), ...FILTERS },
    },
    async ({ subscriptionUuid, environmentIds, capabilityKeys, clusterIds }) =>
      jsonResult(
        await deps.client
          .requireAccount()
          .get(
            `${subsBase(deps)}/${encodeURIComponent(subscriptionUuid)}/usage`,
            filterQuery({ environmentIds, capabilityKeys, clusterIds }),
            UAC_SCOPE,
          ),
      ),
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const BASE = "/platform/iam/v1";

/**
 * Dynatrace IAM (account Identity & Access Management) tools.
 *
 * NOTE: These operate at the ACCOUNT level and require an account-scoped
 * platform token with the relevant iam:* scopes.  Environment-scoped tokens
 * will likely result in 403 responses.
 *
 * level-type: The organisational level kind — "account" or "environment".
 * level-id:   The UUID that identifies the specific level-type instance
 *             (e.g. the account UUID when level-type is "account").
 */
export function registerIamTools(server: McpServer, deps: ToolDeps): void {
  // ── Users ────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_iam_users",
    {
      description:
        "List active users at an organisational level (IAM v1). " +
        "Requires iam:users:read scope on an account-scoped platform token. " +
        "level-type is 'account' or 'environment'; level-id is the corresponding UUID.",
      inputSchema: {
        levelType: z.string().describe("Organisational level type: 'account' or 'environment'."),
        levelId: z.string().describe("UUID of the level-type instance (e.g. account UUID)."),
      },
    },
    async ({ levelType, levelId }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/organizational-levels/${encodeURIComponent(levelType)}/${encodeURIComponent(levelId)}/users`,
        ),
      ),
  );

  server.registerTool(
    "get_iam_user",
    {
      description:
        "Get a single active user by UUID at an organisational level (IAM v1). " + "Requires iam:users:read scope.",
      inputSchema: {
        levelType: z.string().describe("Organisational level type: 'account' or 'environment'."),
        levelId: z.string().describe("UUID of the level-type instance."),
        uuid: z.string().describe("User UUID."),
      },
    },
    async ({ levelType, levelId, uuid }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/organizational-levels/${encodeURIComponent(levelType)}/${encodeURIComponent(levelId)}/users/${encodeURIComponent(uuid)}`,
        ),
      ),
  );

  server.registerTool(
    "add_iam_user",
    {
      description:
        "Add a user to an organisational level (IAM v1, WRITE). " +
        "Requires an account-scoped platform token with iam write scopes. " +
        "level-type is 'account' or 'environment'; level-id is the corresponding UUID.",
      inputSchema: {
        levelType: z.string().describe("Organisational level type: 'account' or 'environment'."),
        levelId: z.string().describe("UUID of the level-type instance."),
        user: z.record(z.unknown()).describe("User definition object (uid, email, groups, permissions, etc.)."),
      },
    },
    async ({ levelType, levelId, user }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(
          `${BASE}/organizational-levels/${encodeURIComponent(levelType)}/${encodeURIComponent(levelId)}/users`,
          user,
        ),
      );
    },
  );

  // ── Service Users ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_iam_service_users",
    {
      description:
        "List active service users usable by the calling user at an organisational level (IAM v1). " +
        "Requires iam:service-users:use scope.",
      inputSchema: {
        levelType: z.string().describe("Organisational level type: 'account' or 'environment'."),
        levelId: z.string().describe("UUID of the level-type instance."),
      },
    },
    async ({ levelType, levelId }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/organizational-levels/${encodeURIComponent(levelType)}/${encodeURIComponent(levelId)}/service-users`,
        ),
      ),
  );

  // ── Groups ────────────────────────────────────────────────────────────────

  server.registerTool(
    "list_iam_groups",
    {
      description:
        "List visible groups at an organisational level (IAM v1). " +
        "Requires iam:groups:read scope on an account-scoped platform token. " +
        "level-type is 'account' or 'environment'; level-id is the corresponding UUID. " +
        "Response array field: results (each item has uuid, groupName, type).",
      inputSchema: {
        levelType: z.string().describe("Organisational level type: 'account' or 'environment'."),
        levelId: z.string().describe("UUID of the level-type instance (e.g. account UUID)."),
      },
    },
    async ({ levelType, levelId }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/organizational-levels/${encodeURIComponent(levelType)}/${encodeURIComponent(levelId)}/groups`,
        ),
      ),
  );

  server.registerTool(
    "create_iam_group",
    {
      description:
        "Create a group at an organisational level (IAM v1, WRITE). " +
        "Requires an account-scoped platform token with iam write scopes.",
      inputSchema: {
        levelType: z.string().describe("Organisational level type: 'account' or 'environment'."),
        levelId: z.string().describe("UUID of the level-type instance."),
        group: z.record(z.unknown()).describe("Group definition object (groupName, description, permissions, etc.)."),
      },
    },
    async ({ levelType, levelId, group }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(
          `${BASE}/organizational-levels/${encodeURIComponent(levelType)}/${encodeURIComponent(levelId)}/groups`,
          group,
        ),
      );
    },
  );

  // ── WIF Trust Policies ────────────────────────────────────────────────────

  server.registerTool(
    "list_trust_policies",
    {
      description:
        "List WIF (Workload Identity Federation) trust policies for an account (IAM v1). " +
        "Requires an account-scoped platform token. Response array field: results.",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
      },
    },
    async ({ accountUuid }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies`,
        ),
      ),
  );

  server.registerTool(
    "get_trust_policy",
    {
      description: "Get a WIF trust policy by UUID, including its service user mappings (IAM v1).",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
        trustPolicyUuid: z.string().describe("Trust policy UUID."),
      },
    },
    async ({ accountUuid, trustPolicyUuid }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies/${encodeURIComponent(trustPolicyUuid)}`,
        ),
      ),
  );

  server.registerTool(
    "create_trust_policy",
    {
      description:
        "Create a WIF trust policy for an account (IAM v1, WRITE). " + "Requires an account-scoped platform token.",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
        trustPolicy: z
          .record(z.unknown())
          .describe("Trust policy definition object (name, issuerUrl, audience, jwksUri, description)."),
      },
    },
    async ({ accountUuid, trustPolicy }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies`,
          trustPolicy,
        ),
      );
    },
  );

  server.registerTool(
    "update_trust_policy",
    {
      description: "Update a WIF trust policy by UUID (IAM v1, WRITE). " + "Requires an account-scoped platform token.",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
        trustPolicyUuid: z.string().describe("Trust policy UUID."),
        trustPolicy: z
          .record(z.unknown())
          .describe("Updated trust policy definition (name, issuerUrl, audience, jwksUri, description)."),
      },
    },
    async ({ accountUuid, trustPolicyUuid, trustPolicy }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.put(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies/${encodeURIComponent(trustPolicyUuid)}`,
          trustPolicy,
        ),
      );
    },
  );

  server.registerTool(
    "delete_trust_policy",
    {
      description:
        "Delete a WIF trust policy by UUID (IAM v1, WRITE, destructive). " +
        "Requires an account-scoped platform token.",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
        trustPolicyUuid: z.string().describe("Trust policy UUID to delete."),
      },
    },
    async ({ accountUuid, trustPolicyUuid }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.del(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies/${encodeURIComponent(trustPolicyUuid)}`,
        ),
      );
    },
  );

  // ── WIF Trust Policy Mappings ─────────────────────────────────────────────

  server.registerTool(
    "list_trust_policy_mappings",
    {
      description: "List WIF service user mappings for a trust policy (IAM v1). " + "Response array field: results.",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
        trustPolicyUuid: z.string().describe("Trust policy UUID."),
      },
    },
    async ({ accountUuid, trustPolicyUuid }) =>
      jsonResult(
        await deps.client.platform.get(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies/${encodeURIComponent(trustPolicyUuid)}/mappings`,
        ),
      ),
  );

  server.registerTool(
    "create_trust_policy_mapping",
    {
      description:
        "Create a WIF service user mapping for a trust policy (IAM v1, WRITE). " +
        "Requires an account-scoped platform token.",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
        trustPolicyUuid: z.string().describe("Trust policy UUID."),
        mapping: z
          .record(z.unknown())
          .describe("Mapping definition (serviceUserUuid, environmentId, scopes, claimMappings)."),
      },
    },
    async ({ accountUuid, trustPolicyUuid, mapping }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies/${encodeURIComponent(trustPolicyUuid)}/mappings`,
          mapping,
        ),
      );
    },
  );

  server.registerTool(
    "delete_trust_policy_mapping",
    {
      description:
        "Delete a WIF service user mapping by UUID (IAM v1, WRITE, destructive). " +
        "Requires an account-scoped platform token.",
      inputSchema: {
        accountUuid: z.string().describe("Account UUID."),
        trustPolicyUuid: z.string().describe("Trust policy UUID."),
        mappingUuid: z.string().describe("Mapping UUID to delete."),
      },
    },
    async ({ accountUuid, trustPolicyUuid, mappingUuid }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.del(
          `${BASE}/organizational-levels/accounts/${encodeURIComponent(accountUuid)}/wif/trust-policies/${encodeURIComponent(trustPolicyUuid)}/mappings/${encodeURIComponent(mappingUuid)}`,
        ),
      );
    },
  );
}

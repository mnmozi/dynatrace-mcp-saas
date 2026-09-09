# Account Management API — operational reference

Read this when wiring account OAuth or debugging a 4xx from any account tool (policies,
boundaries, bindings, groups, users, platform-tokens, cost, permissions). For policy/
boundary *grammar*, read the `policies-and-boundaries` topic instead.

## Symptom → cause → fix (start here)

| Symptom | Cause | Fix |
|---|---|---|
| `400 invalid_request` at token time | OAuth client lacks the scope this tool requests, or a multi-scope token was requested | Grant the scope on the OAuth client (map below). Never request >1 scope per token. |
| 401/403 on **every** account call | Token issuer ≠ API host (e.g. a sprint SSO token hitting the public host) | Point `DT_ACCOUNT_API_URL` **and** `DT_SSO_TOKEN_URL` at the matching environment |
| `404` on `GET .../groups/{groupUuid}` | No single-group GET exists | List groups and select (`findAccountGroup`) |
| `404` on `PUT /bindings/{policyUuid}` | That route does not exist | Use `PUT /bindings/groups/{groupUuid}` or `POST /bindings/{policyUuid}` |
| `403` creating a platform-token | Service user lacks the platform-token permission (separate from the OAuth scope) | Grant that permission, or act as an admin identity |
| `/groups/{g}/permissions` returns `[]` | That endpoint returns LEGACY account roles only — NOT IAM policy permissions | Use `describe_group_permissions` for real IAM perms |

## Credentials — three types, never interchangeable

| Credential | Prefix | Header | Reaches |
|---|---|---|---|
| Platform token | `dt0s16` | `Bearer` | `/platform/*` on the tenant apps host |
| Classic API token | `dt0c01` | `Api-Token` | `/api/v2` on the classic host |
| Account OAuth client | `dt0s02` | client-credentials → SSO → `Bearer` | Account Management API (separate host) |

All account tools use the OAuth client only. Tenant platform/classic tokens cannot reach
the Account Management API, and vice-versa.

## Host — NOT your tenant host

- **Prod:** `https://api.dynatrace.com` (default).
- **Sprint / hardening:** the public host **rejects sprint SSO tokens** (issuer mismatch).
  Use `https://api-hardening.internal.dynatracelabs.com`, which trusts `sso-sprint` tokens.
  Set `DT_ACCOUNT_API_URL` and `DT_SSO_TOKEN_URL` together for the same environment.

## Scopes — ONE per token (SSO rejects multi-scope with `400 invalid_request`)

The OAuth client must be **created with every scope you will use** — a missing scope fails
at token-fetch time, not call time. A token is fetched and cached **per scope**.

| Scope | Powers |
|---|---|
| `iam-policies-management` | policies, boundaries, bindings (the "repo" API) |
| `account-idm-read` | list/get groups, users, memberships; list platform-tokens |
| `account-idm-write` | create/update/delete groups; create/delete platform-tokens |
| `account-uac-read` | subscriptions / cost / usage |

`DT_OAUTH_SCOPE` sets only the **default** scope; each tool overrides it per call. It does
not limit which scopes the client may request.

## Endpoint quirks — these violate the obvious prior

- **Single group:** you'd expect `GET /iam/v1/accounts/{uuid}/groups/{groupUuid}`. It
  **404s.** The list endpoint and the group sub-resources (`/users`, `/permissions`) work —
  resolve one group by list-and-select.
- **Binding update:** you'd expect `PUT /bindings/{policyUuid}`. It **404s.** Real routes:
  group-centric `PUT /bindings/groups/{groupUuid}` body `{policyUuids}` → 204 (replaces the
  group's whole set); policy-centric `POST /bindings/{policyUuid}` body `{groups, boundaries}`.
- **Bindings are create-only** — you can't edit a binding's boundaries in place (POST/PUT on
  an existing binding 400s "binding already exists"). To change boundaries: delete-and-recreate
  (`unbind_policy_from_group` → `bind_policy_to_groups` with the new boundary UUIDs). The
  `rebind_policy_boundaries` tool does exactly this in one call.
- **`/groups/{g}/permissions`** returns LEGACY account roles, usually `[]` — this is NOT
  "the group has no access." IAM policy permissions come from bindings, not this endpoint.
- **Group membership is USER-centric.** There is no group-side "add member" endpoint. Add a
  user to groups with `POST /iam/v1/accounts/{uuid}/users/{email}` body = bare array of group
  UUIDs (additive); remove with `DELETE /groups/{groupUuid}/users/{email}`. Tools:
  `add_user_to_groups` / `remove_user_from_group`. (Group DELETE, by contrast, is UI-only — the
  API 403s.)

## Platform tokens — `userUuid` = act AS that user

`POST /iam/v1/accounts/{uuid}/platform-tokens` with `userUuid` mints a token **owned by and
acting AS that user** — it enforces THAT user's IAM permissions and boundaries. Use it to
test a user's effective access without them logging in (point a second MCP server at it).
- Needs `account-idm-write` **plus** a platform-token permission the service user may lack (403).
- The secret is returned **once** — treat as a credential.

## Effective permissions — caller-only

- `POST /platform/management/v1/effective-permissions:resolve` answers "can **the caller**
  do X" (optional context key-values). No user parameter — there is no "resolve for user X"
  endpoint (every `/accounts/{uuid}/users/{id}/permissions` variant 404s).
- Audit another group → `describe_group_permissions`: composes group → members → bindings →
  each policy `statementQuery` → each boundary `boundaryQuery` = API-derived ground truth
  (diff it against the Account Management UI resolver).
- Measure a specific user's live access → mint an acts-as-user token (above) and call the
  resolver AS them.

## Entity security context — use the API, not the settings schema

`dt.security_context` on **records** comes from the OpenPipeline securityContext processor.
On **entities** (hosts/services/PGs) it does NOT: entities never pass through a pipeline.

- The documented settings schema `builtin:monitoredentities.grail.security.context`
  is **absent (404) on Gen3/Grail-first builds** — as is classic `builtin:tags.auto-tagging`.
  Don't retry it; it's not provisioned there.
- The **working path is the classic Entities v2 API**, which is live on those builds:
  - `POST /api/v2/entities/securityContext` — **assigns** context to entities matching a
    REQUIRED `entitySelector` query param; body `{"securityContext":["app-kargo"]}`;
    returns `{entityIds, managementZoneIds}` = the affected entities.
  - `DELETE /api/v2/entities/securityContext` — removes it.
  - Both need the classic token with **`settings.write`**.
  - Tools: `set_entity_security_context` / `delete_entity_security_context` (both support
    `dryRun` to preview the blast radius first).
- ⚠️ **Management-zone rules stop applying to any entity that has a security context set.**
  Deleting the security context restores them. Always dry-run before a broad selector.

This is what makes entity-scoped IAM boundaries enforceable: boundaries evaluate
`dt.security_context`, and this API is how entities get it.

## Effective access = OAuth scopes ∩ IAM permissions

Two independent gates. Scope missing → 400/403 at the API layer. IAM denies → empty or
filtered result. When access looks wrong, check both.

# Changelog

## 0.22.1

- OpenPipeline Configurations API reached END OF LIFE on 2026-06-29 (docs-confirmed verbatim). `update_openpipeline_configuration` no longer attempts the dead `PUT /platform/openpipeline/v1/configurations/{id}`: it keeps the still-supported batch-verify of every DQL processor + matcher and, on the write path (write-gate unchanged), returns a deterministic `{applied:false, deprecated:true, useInstead:{schemas:[builtin:openpipeline.<scope>.pipelines / .routing / .ingest-sources]}}` redirect instead of a confusing "Migration completed" 4xx
- `get_openpipeline_configuration` / `list_openpipeline_configurations` descriptions corrected: the GET still works but returns each scope's capability DEFINITION (per-stage processor allow-list, custom-endpoint base path, default bucket) — NOT the pipelines/routing, which are Settings 2.0 objects. Scope ids corrected to the live values (security.events, events.sdlc, davis.events, davis.problems, user.events, usersessions, smartscape.events, system.events)
- knowledge: openpipeline-authoring gotcha upgraded from "on some builds" to the definitive EOL + what GET now returns; fixed `.ingest-sources` (hyphen, was underscore); openpipeline-processors gains the live per-scope processor allow-list matrix (technology only on logs/security.events; bizevent extractor never on bizevents; metrics has no extraction/davis/storage; system.events has an EMPTY processing stage; only events/security.events/events.sdlc expose custom endpoints)
- Re-verified against Sep 2026 docs: OpenPipeline ingest endpoints (paths, host, dual scope spellings) unchanged; `security.events` (the non-legacy path) is what we use

## 0.22.0

- new ingest_openpipeline_events: OpenPipeline ingest (POST /platform/ingest/v1/{events|events.sdlc|security.events|smartscape.events}, or a custom endpoint via /platform/ingest/custom/<category>/<name>). HOST: these /platform/ingest/* endpoints are data-plane and served on the ENVIRONMENT/classic host (…dynatracelabs.com), NOT the apps host — so the tool routes through the classic client (Api-Token), and the classic API token (DT_API_TOKEN) must carry the matching openpipeline.* scope. Append retry-class (never retries 5xx/network — a retry would duplicate the record)
- Re-verified the ingest endpoints against current docs (Sep 2026): host = {env}.live.dynatrace.com (environment domain — confirms the classic-client routing), auth = Api-Token, paths unchanged. Two facts baked into the tool description / .env / knowledge doc: (1) each event needs `event.id`; (2) every ingest endpoint has TWO scope spellings by token type — Api-Token dot-style (openpipeline.events) vs Platform-token IAM colon-style (openpipeline:events:ingest). Security events' "legacy" vs "new" differ ONLY in that auth style; the path /platform/ingest/v1/security.events is identical — no path change needed
- fix ingest_bizevents content-type bug: it demanded a CloudEvent envelope (id/source/specversion/type) but sent application/json, which expects LITERAL keys (event.type/event.provider) — producing junk records with event.type='unknown'. Now: default = plain application/json (literal keys, what actually works); cloudEvent:true sends application/cloudevent+json (single) or application/cloudevents-batch+json (array). Description rewritten to make the two formats explicit
- new raw_post: a narrowly-scoped write escape hatch RESTRICTED to /platform/ingest/* (schema regex + defense-in-depth recheck); any other path is rejected so config/settings writes keep their typed-tool validation. Write-gated, append retry-class. (raw_get stays GET-only)
- HTTP client: requests can override Content-Type (RequestOpts.contentType) — enables the bizevents CloudEvent formats and raw_post custom content types
- openpipeline_reference 'authoring' topic: added a Primary Grail tags section (builtin:openpipeline.primary-grail-tag — global, pre-routing, ordered rules writing into the primary_tags namespace; first-existing source field; unique tag name) with a flagged TODO for the classic-events flattening detail
- new set_entity_security_context / delete_entity_security_context (classic POST/DELETE /api/v2/entities/securityContext): assign or remove dt.security_context on monitored ENTITIES matching an entitySelector — the entity-side counterpart to the OpenPipeline securityContext processor, and what entity-scoped IAM boundaries evaluate. This closes a real gap: the documented settings schema builtin:monitoredentities.grail.security.context 404s on Gen3/Grail-first builds (classic builtin:tags.auto-tagging is absent too), and the endpoint was unreachable because raw_get is GET-only. Both tools are write-gated (needs classic settings.write) and support dryRun, which resolves the entitySelector read-only to show the blast radius first — important because setting a security context SILENTLY STOPS management-zone rules from applying to those entities (deleting it restores them)
- new openpipeline_reference tool + knowledge/openpipeline/** (3 topics) to make authoring complex pipelines first-class through the generic Settings 2.0 path (no per-schema wrapper). Grounded from the live pipelines schema + Dynatrace docs: 'processors' (all 25 processor types mapped to the 10 stages, attribute shapes, the constant/field/multiValueConstant value-assignment modes), 'scripting' (the dql-processor command SUBSET — parse/fieldsAdd/fields/fieldsKeep/fieldsRemove/fieldsRename/fieldsFlatten, explicitly NOT fetch/filter/summarize; the full scalar function catalog; matcher grammar matchesPhrase/matchesValue/isNull + and/or/not — the two-language rule), 'authoring' (pipelines/routing/pipeline-groups object model per signal type, record flow, the read→dry-run→apply recipe, and gotchas: migration state, hyphenated schemaId, references by object id, composition stage-inclusion)
- new rebind_policy_boundaries: change the boundaries on an EXISTING policy→group binding. Bindings are create-only (POST/PUT on an existing binding 400s 'binding already exists'), so this does the documented delete-and-recreate — unbind then re-bind with the new boundary set — composing two already-live-verified calls (no new endpoint). Pass boundaries:[] to make the binding unconditional; if the re-bind fails after the unbind, the response returns rebound:false with a recovery warning (the group is left unbound)
- new add_user_to_groups / remove_user_from_group: group membership via the Account Management IDM API. Membership is USER-centric — add = POST /users/{email} with a bare array of group UUIDs (additive), remove = DELETE /groups/{g}/users/{email}; there is no group-side 'add member' endpoint (which is why it looked like a gap). Write-gated + account-idm-write. Read shape live-verified; write shapes follow the documented API — confirm once against a throwaway group before trusting in automation

- HTTP retry engine consolidated into ONE place (src/http/retry.ts) shared by the platform/classic client AND the account client. Retry safety is now method/data-aware via a `retryClass`:
  - `idempotent` (GET/PUT/DELETE) → retry on 429/408, 5xx, and network errors
  - `create` (config POST) → retry on 429/408 and network, but NOT 5xx (a duplicate config is at least visible/deletable by name)
  - `append` (data ingest — logs/events/bizevents) → retry ONLY on 429/408 (rejected before processing); NEVER on 5xx/network, because a retry would create a DUPLICATE record with no stable identity
- Per-call control from the calling class: a `verifyApplied()` hook (salvage an ambiguous write by checking whether the effect landed → its return value becomes the result) and a `shouldRetry()` predicate override. The three ingest tools are tagged `retryClass:"append"`
- AccountClient now routes through the shared engine (previously bare fetch, no retry) — gains retry + DynatraceApiError-wrapped timeouts; the SSO token request retries as idempotent
- DELETE that 404s on a retry is treated as success ("already deleted") instead of surfacing a spurious not-found
- Validation is fail-transparent: davis execute + openpipeline update block ONLY on an EXPLICIT failure (valid=false / ERROR notification); an inconclusive or warning-only validation proceeds with a surfaced `validationWarning`/`validationWarnings` rather than blocking the write on API ambiguity
- Refactor: shared src/util/account-iam.ts (ACCOUNT_SCOPES, ACCOUNT_NOTES, LEVEL_TYPE/LEVEL_ID, accountBase, repoLevelPath) replaces the boilerplate that 7 account modules hand-copied and had already drifted between files
- Test coverage: closed the flagged gaps — permissions.ts (describe_group_permissions composition + group-filter + graceful legacy fallback + resolve_effective_permissions), AccountClient retry wiring (idempotent 5xx retry, DELETE-404-on-retry, SSO-token retry, retryClass passthrough), retry-engine unit tests (the classAllowsRetry table, append/create/verifyApplied behaviors), and an iam_reference smoke test. Every tool module now has coverage
- Docs/knowledge: new knowledge/iam/account-api-operations.md — the operational reference the public docs don't spell out (host/issuer for sprint vs prod, one-scope-per-token + the scope→tool map, endpoint quirks like no single-group GET and the binding method, acts-as-user platform tokens, caller-only effective-permissions). Served as a new iam_reference topic 'account-api-operations'. .env.example refreshed: documents DT_OAUTH_SCOPE as a default-only knob, the full multi-scope requirement, sprint host overrides, and the class-aware retry semantics

## 0.21.1

- fix iam boundary tools level handling: LEVEL_TYPE now includes 'global' (was account/environment only) and repoPath throws when levelType='environment' is passed without a levelId — matching the policies contract (previously it silently built /repo/environment/<accountUuid>/... , a wrong path)
- fix DQL execute: a SUCCEEDED response with no result object (empty result set) now returns normalize(undefined) instead of throwing a misleading "no requestToken" error
- config: numeric env tunables (DT_HTTP_TIMEOUT_MS/DT_MAX_RETRIES/DT_RETRY_BASE_MS) fall back to defaults when non-finite, not NaN

## 0.21.0

- Account Platform Tokens tools: list/create/delete_platform_token (/iam/v1/accounts/{uuid}/platform-tokens). create takes userUuid — the token is OWNED BY and ACTS AS that user, enforcing their IAM permissions/boundaries. Enables testing a user's effective access without them logging in. Writes need account-idm-write; token secrets are shown once — treat as credentials

## 0.20.1

- fix get_account_group and describe_group_permissions: the account IDM API has NO single-group GET (/iam/v1/accounts/{uuid}/groups/{groupUuid} → 404, while the list and the /users + /permissions sub-resources work). Both now resolve the group from the list endpoint via a shared findAccountGroup helper; missing groups give a clear error
- describe_group_permissions also surfaces legacyPermissions (the old account-role grants, distinct from IAM policy permissions — empty for policy-only groups)
- Regression test: get_account_group must never request /groups/{uuid} (it had zero coverage, which is how the dead route shipped)

## 0.20.0

- resolve_effective_permissions: typed tool for POST /platform/management/v1/effective-permissions:resolve (caller-identity only, optional context key-values) — the raw escape hatch is GET-only, so this endpoint needed a typed tool
- describe_group_permissions: composes a group's full effective IAM permission set deterministically from the authored objects (group → members → bindings → policy statementQuery → boundary boundaryQuery). API-derived ground truth for auditing / diffing against the UI resolver
- raw_get gains host="account" (+ optional scope) so the Account Management API is reachable ad hoc
- Probed: no account-level "resolve for user X" endpoint exists (all /users/{id}/permissions variants 404); /groups/{g}/permissions returns only LEGACY account roles (empty here), not IAM policy permissions

## 0.19.2

- Account user & membership tools (Account Management IDM API, account-idm-read): list_account_users, get_account_user (by email, incl. groups), list_group_members — closes the group-membership gap. The platform-host IAM endpoints 403 without an account-scoped platform token carrying iam:users:read; the account IDM API needs no platform token at all
- Live-verified end-to-end (group membership auditable via API for the first time)

## 0.19.1

- fix bind_policy_to_groups: "update bindings of a policy" is a POST, not a PUT — PUT /bindings/{policyUuid} does not exist (404 live-verified)
- new set_group_policies: PUT /bindings/groups/{groupUuid} with {policyUuids} — the documented, reliable group-centric assignment (replaces the group's whole set; returns 204)
- iam_reference doc updated with the binding endpoint table (method matters) and the corrected create→assign loop

## 0.19.0

- Cost & consumption tools (Dynatrace Platform Subscription API, /sub/v2): list_subscriptions, get_subscription, get_subscription_cost (breakdown, filter by environment/capability/cluster), get_subscription_usage. Read-only, routed through the multi-scope account client with the account-uac-read scope
- Requires the OAuth client to carry account-uac-read (docs-confirmed scope); lights up once granted

## 0.18.2

- Account group tools (Account Management IDM API): list/get/create/update/delete_account_group. Groups are a SEPARATE API from policies/boundaries and need different OAuth scopes — account-idm-read (reads) / account-idm-write (writes)
- AccountClient is now multi-scope: fetches + caches a token PER scope (SSO rejects multi-scope requests), so the same OAuth client serves iam-policies-management (repo API) and account-idm-* (groups) side by side
- Live-verified: list_account_groups returns real groups via account-idm-read. create/update/delete require the OAuth client to also carry account-idm-write

## 0.18.1

- New iam_reference tool + knowledge/iam doc: IAM policy statement syntax (ALLOW/DENY, service:resource:action, WHERE operators, AND-only, DENY-override), boundary syntax (field/op/value, one condition per line, IN/startsWith, max 10, no AND), permission vocabulary, and the create→bind loop — grounds create_policy/create_policy_boundary. Grammar from Dynatrace docs; examples live-verified

## 0.18.0

- IAM policies + bindings tools (Account Management Repo API), completing the IAM triad with the existing boundary tools:
  - Policies: list/list_aggregate/get/create/update/delete_policy (statementQuery-based)
  - Bindings: list_policy_bindings, get_group_policy_bindings, bind_policy_to_groups (policy→groups, optional boundaries — the step that makes a policy take effect), unbind_policy_from_group
  - All support account/environment/global levels (levelType/levelId)
- Confirmed the sprint account IAM API is reachable at api-hardening.internal.dynatracelabs.com (see 0.17.1)

## 0.17.1

- New optional DT_IAM_TOKEN: a dedicated platform token carrying iam:* scopes. IAM tools (users/groups/service-users) use it when set and fall back to DT_PLATFORM_TOKEN otherwise — the main token stays unchanged and the IAM token needs ONLY the iam scopes
- raw_get gains host="iam" (platform host with the IAM token) for probing IAM routes
- get_server_info reports configured.iamToken

## 0.17.0

- IAM policy boundaries (Account Management API): list/get/create/update/delete_policy_boundary — boundaries restrict where policy bindings apply via boundary queries
- New optional third credential: OAuth client-credentials flow (DT_OAUTH_CLIENT_ID + DT_OAUTH_CLIENT_SECRET + DT_ACCOUNT_URN, all-or-nothing) against the Dynatrace SSO token endpoint, with token caching; DT_SSO_TOKEN_URL / DT_ACCOUNT_API_URL host overrides
- get_server_info reports configured.account; clear "not configured" error when the trio is absent

## 0.16.1

- fix get_filter_segment: request add-fields=INCLUDES,VARIABLES by default (the API hides segment content otherwise); addFields override supported; list_filter_segments gains addFields too
- fix update_filter_segment: send the REQUIRED optimistic-locking-version as a query parameter (updates previously always 400'd); explicit version input added
- new raw_get tool: read-only escape hatch for uncovered endpoints/query params (platform or classic host); GET-only by design — raw writes stay unexposed to preserve validation guards
- HTTP client: query params now support arrays (sent as repeated params)

## 0.16.0

- Davis Analyzers tools: list_davis_analyzers, get_davis_analyzer, get_davis_analyzer_input_schema (grounding), validate_davis_analyzer_input (online dry-run), execute_davis_analyzer (auto-validates first; polls 202 long-running executions) — live-verified end-to-end (forecast COMPLETED)
- New dql_reference topic "davis": detector/analyzer DQL rules (timeseries-shaped output, never pin from:/to: — the analyzer owns the sliding window; no limit; bounded by: cardinality; default:0 vs null alerting semantics)

## 0.15.2

- dql-reference §15 extended with practical makeTimeseries parameters & gotchas (default:0 vs null bins, count() aliasing, bins default 120 + boundary alignment, rate:, nonempty:, time:/spread:, timeframe inheritance) — live-verified

## 0.15.1

- New dql_reference topic "fields": Grail field model (schema-on-read, who creates fields), semantic-dictionary lookup recipes, primary fields + semantic tags, fieldsets truth (builtins = sensitive classifications), masking tiers, probe-first field-discovery flow, count() alias gotcha — all live-verified

## 0.15.0

- Grail Resource Store tools: test_lookup_pattern (online parse check, stores nothing), upload_lookup_data (auto-verified via test-pattern before storing + dryRun) for DQL `lookup` enrichment data, delete_resource_file
- Grail Fieldsets tools: list/get/create/update/delete_fieldset (curated field presets per table/bucket/tenant)

## 0.14.0

- verify_dql/execute_dql surface Dynatrace's real error detail (errorType, message, line/column) instead of a generic "request failed"; DynatraceApiError carries structured detail for all tools

## 0.13.0

- update_openpipeline_configuration auto-verifies every DQL processor + matcher via the online verify endpoints before applying (returns problems, no write on failure); new dryRun flag

## 0.12.0

- Settings writes auto-validate via the online validateOnly endpoint before persisting (returns constraintViolations, no write on failure); new dryRun flag on create/update_settings_object

## 0.11.0

- Snapshot ALL settings-schema full definitions (specs/settings-schemas/*.json) for offline create/update grounding; check_settings_schema_drift now does structural deep-diff for any schema; refresh-snapshots keeps them current

## 0.10.0

- Data-extraction tools: get_bizevent_capture_rules (summarize bizevent HTTP capture rules) and describe_log_fields (discover JSON log fields)

## 0.9.0

- dashboard_reference + list_dashboard_topics tools serving vendored Dynatrace dashboard/notebook authoring skills (tile types, visualizations, examples)

## 0.8.0

- HTTP client resilience: retry with exponential backoff on 5xx/408/network; honor 429 Retry-After (configurable DT_MAX_RETRIES / DT_RETRY_BASE_MS)
- Pagination cursors on list_settings_objects/schemas, list_problems, list_audit_logs (classic nextPageKey) + list_dashboards/notebooks (page-key)
- Partial-credential mode: start with platform-only or classic-only; absent host fails with a clear message; get_server_info reports configured hosts

## 0.7.0

- Vendored the official Dynatrace `dt-dql-essentials` skill (Apache-2.0) under knowledge/dql/vendor/
- dql_reference: new `official` topic + `officialRef` param; new list_dql_official_references tool

## 0.6.0

- Embedded DQL knowledge: dql_reference + list_dql_topics tools (and dql:// resources) serving a bundled Grail DQL playbook/reference so DQL is authored locally — no Davis CoPilot dependency

## 0.5.0

- Feature Management (feature flags): projects, features, flags, release stages
- IAM: account users/groups/service-users + WIF trust policies & mappings

## 0.4.0

- Grail bucket management (storage management), filter segments, record deletion
- Extensions v2 (list/get + monitoring-config CRUD), notifications (self v1 + event v2)
- Email send, data ingest (logs/events/bizevents), audit logs read

## 0.3.0

- Automation/Workflows tools: list/get/create/update/delete/run workflows + list/get executions (platform Automation v1)

## 0.2.0

- Gen3-first: query_metric via Grail DQL timeseries; entities tools default to Grail DQL with optional useClassic flag
- Drift suite (settings-schema + API-spec drift, live-schema validation) and refresh-snapshots script
- OpenPipeline tools incl. pipeline preview chaining; typed Zod request bodies; contentPath support for documents
- get_server_info tool + build stamping

## 0.1.0

- Initial release: 60+ tools across observability and configuration, dual-host/dual-token client, write gating

# Changelog

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

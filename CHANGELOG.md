# Changelog

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

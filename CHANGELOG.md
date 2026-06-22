# Changelog

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

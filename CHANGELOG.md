# Changelog

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

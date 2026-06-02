# Dynatrace SaaS MCP Server — Design

**Date:** 2026-06-02
**Status:** Approved (pending spec review)
**Target tenant:** `asn8731h.sprint.apps.dynatracelabs.com` (Gen3 "apps" / Platform), cluster **v1.341.9**

## 1. Purpose

A Model Context Protocol (MCP) server for **Dynatrace SaaS (Gen3 Platform)** that covers
both **configuration/management** and **observability** — filling the gap left by the
official `dynatrace-oss/dynatrace-mcp`, which has no dashboard-creation or settings-management
tools.

The guiding loop: **discover** (hosts/entities) → **measure** (metrics/logs/traces) →
**build** (dashboards/settings/SLOs). Observability data exists so we can make sense of the
environment and then create meaningful configuration.

## 2. Hard-won environment facts (verified live, Phase 0)

These were confirmed empirically against the tenant and drive the architecture:

1. **Two hosts, two token types** (a classic token returns `"Could not parse JWT"` on platform APIs — it is a *type* mismatch, not a permissions one):

   | Surface | Host | Token | Header |
   |---|---|---|---|
   | Platform (`/platform/*`) | `https://asn8731h.sprint.apps.dynatracelabs.com` | Platform token `dt0s16…` | `Authorization: Bearer <token>` |
   | Classic (`/api/v1`,`/api/v2`) | `https://asn8731h.sprint.dynatracelabs.com` | API token `dt0c01…` | `Authorization: Api-Token <token>` |

2. **Classic dashboards API is removed** on this tenant (`/api/config/v1/dashboards` → 404
   `"REST endpoint is not available for this environment"`). Dashboards & notebooks are
   **documents** at `/platform/document/v1` and require the platform token.

3. **DQL is async**: `POST /platform/storage/query/v1/query:execute` returns `202` with a
   `requestToken`; results are retrieved via `query:poll`.

4. **Scopes matter.** The classic token needs `metrics.read`, `slo.read/write`, `logs.read`,
   `settings.read/write` added (some returned 403 during probing). The platform token needs
   Grail `storage:*:read` + `document:documents:read/write`.

## 3. API source of truth

All 31 OpenAPI specs were downloaded from the live tenant into `specs/` (Phase 0 artifact):
- `specs/platform/*.yaml` — 29 platform specs (catalog at `/platform/metadata/v1/swagger-ui.json`)
- `specs/classic/environment-api-v{1,2}.json` — classic Environment API (from `/api/v{1,2}/spec3.json`)

Tools are built **from these specs**, not from memory. Request/response Zod schemas are
derived from the spec definitions; Settings 2.0 payloads are validated against **live**
schemas fetched at runtime.

## 4. Tool catalog (v1) — grounded in real endpoints

`*` = write operation (gated). Prefer **platform-native** APIs where they exist on Gen3.

### Observability (read-only)
- **DQL:** `execute_dql` (execute + poll loop), `verify_dql` — `/platform/storage/query/v1`
- **Logs:** `search_logs` (curated → `fetch logs | filter… | sort… | limit…` via DQL)
- **Traces/Spans:** `search_spans`, `get_trace` (via DQL `fetch spans`)
- **Metrics:** `list_metrics`, `get_metric_metadata`, `query_metric` — classic `/api/v2/metrics`
- **Entities/Hosts:** `list_hosts`, `get_host`, `find_entities`, `get_entity`,
  `get_entity_relationships` — classic `/api/v2/entities`,`/entityTypes`
- **Problems:** `list_problems`, `get_problem` — classic `/api/v2/problems`
- **Vulnerabilities** *(bonus, read):* `list_vulnerabilities`, `get_vulnerability` — `/platform/vulnerabilities/v1`

### Configuration / management
- **Dashboards (documents):** `list_dashboards`, `get_dashboard`, `create_dashboard*`,
  `update_dashboard*`, `delete_dashboard*` — `/platform/document/v1` (type `dashboard`)
- **Notebooks (documents):** `list/get/create*/update*/delete*` — `/platform/document/v1` (type `notebook`)
- **Settings 2.0:** `list_settings_schemas`, `get_settings_schema`, `list_settings_objects`,
  `get_settings_object`, `create_settings_object*`, `update_settings_object*`,
  `delete_settings_object*`, `validate_settings_object` — classic `/api/v2/settings`
- **SLOs:** `list_slos`, `get_slo`, `create_slo*`, `update_slo*`, `delete_slo*`,
  `evaluate_slo`, `list_objective_templates` — `/platform/slo/v1`
- **Synthetic:** `list_monitors`, `get_monitor`, `create_monitor*`, `update_monitor*`,
  `delete_monitor*`, `list_locations`, `list_nodes` — `/platform/synthetic/v1`

Out of scope for v1 (specs retained for later): AppEngine, Automation, OpenPipeline,
Davis CoPilot, Email/Notification, Extensions, IAM, Feature flags.

## 5. Architecture

TypeScript, `@modelcontextprotocol/sdk` + `zod`, **stdio** transport, Node 20+, **vitest**.
Each file has one job; everything that touches the network goes through one client.

```
saas-mcp/
  src/
    index.ts          # entry: build server, register tools, start stdio transport
    config.ts         # parse + validate env (two URLs, two tokens, write flag); fail fast
    http/
      client.ts       # DynatraceClient — ONLY component doing HTTP
      dql.ts          # DQL execute+poll helper (async 202 → poll → results)
      errors.ts       # map status codes → friendly MCP errors
    tools/
      registry.ts     # registerAll() — single source of the tool set + write-gating
      dql.ts  logs.ts  traces.ts  metrics.ts  entities.ts  problems.ts  vulnerabilities.ts
      dashboards.ts  notebooks.ts  settings.ts  slos.ts  synthetic.ts
    schemas/          # shared Zod schemas derived from specs
    util/guards.ts    # requireWrites()
  specs/              # downloaded OpenAPI specs (grounding artifact, committed)
  test/               # vitest, HTTP mocked (msw); + live smoke tests (gated, skipped by default)
  .env.example  README.md  package.json  tsconfig.json
```

### 5.1 DynatraceClient (the core)
The single networking component. Two method families pick host + auth automatically:
- `classic.get/post/put/del(path, …)` → `DT_CLASSIC_URL` + `Api-Token`
- `platform.get/post/put/del(path, …)` → `DT_PLATFORM_URL` + `Bearer`

Centralizes: base URLs, timeout (`DT_HTTP_TIMEOUT_MS`), **pagination** (`nextPageKey` for
classic, `nextPageKey`/cursor for platform), **429 Retry-After** handling, and **error
normalization**. Nothing else imports `fetch`.

### 5.2 DQL helper
`executeDql(query, opts)` posts to `query:execute`, then polls `query:poll` with the
`requestToken` until `state !== RUNNING`, with a bounded poll loop + timeout. Returns
records. Used by `execute_dql`, `search_logs`, `search_spans`, `get_trace`.

### 5.3 Tool module contract
Each module exports `register(server, client, opts)`. Each tool: a Zod input schema, a
handler that calls the client, and a structured/summarized JSON result (not raw dumps) so the
model can reason over it. `execute_dql` is the raw escape hatch.

## 6. Guardrails — read-only by default

- Writes are blocked unless `DT_ENABLE_WRITES === "true"`.
- Write tools are **still registered** (discoverable) but their handler first calls
  `requireWrites()`, which throws a clear MCP error:
  `"Write blocked: set DT_ENABLE_WRITES=true to enable mutating operations."`
- This makes the write surface visible/learnable while keeping the live tenant safe by default.

## 7. Error handling

Normalized in `http/errors.ts`:
- **401** → "Auth failed — check token type/validity for this host." (reminds: platform=JWT, classic=Api-Token)
- **403** → "Missing scope — token lacks the required scope for this endpoint." (name it when known)
- **404** → "Not found (or endpoint unavailable on this tenant)."
- **429** → respect `Retry-After`, surface remaining wait.
- **Settings 4xx** → surface Dynatrace `constraintViolations` verbatim so the model self-corrects.
- **DQL errors** → surface the query + the API error detail.

## 8. Testing (TDD)

- **vitest** with **msw**-mocked HTTP. Cover: client host/auth routing, write-gating,
  DQL execute→poll loop, pagination, error normalization, and each tool's request shaping +
  response parsing.
- **Live smoke tests** gated behind `DT_LIVE_TEST=1` (skipped in CI), validating a handful of
  read-only calls against the sprint tenant.

## 9. Out of scope / deferred

- HTTP/SSE transport (stdio only for v1).
- AppEngine, Automation, OpenPipeline, Davis CoPilot, Email/Notification, Extensions, IAM,
  Feature-flag tools (specs retained).
- OAuth-client auth flow (platform token is sufficient).

## 10. Open items to resolve during implementation

- Confirm exact Document `content` shape for a valid dashboard (fetch an existing one as a template).
- Confirm metric query verb/params on classic (`GET /api/v2/metrics/query?metricSelector=…`).
- Confirm classic token scopes after the user adds `metrics.read`, `slo.*`, `logs.read`, `settings.*`.

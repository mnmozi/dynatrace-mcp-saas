# Dynatrace SaaS MCP Server

![CI](https://github.com/mnmozi/dynatrace-mcp-saas/actions/workflows/ci.yml/badge.svg)

An [MCP](https://modelcontextprotocol.io) server for **Dynatrace SaaS (Gen3 Platform)** that exposes observability and configuration capabilities as tools for LLM agents (Claude Code, Claude Desktop, and any other MCP-compatible client).

---

## Overview

This server bridges AI agents with Dynatrace SaaS, providing:

- **Observability** — DQL queries, log search, span/trace lookup, metrics, entities, problems, vulnerabilities
- **Configuration** — Settings 2.0 CRUD, dashboards, notebooks, SLOs, synthetic monitors

All write operations (create / update / delete) are **blocked by default** and must be explicitly enabled with `DT_ENABLE_WRITES=true`.

---

## Two-Host / Two-Token Model

Dynatrace SaaS exposes APIs across two distinct hostnames, each requiring a different token type.

| Host | Env var | Example value | Auth header | APIs served |
|------|---------|---------------|-------------|-------------|
| **Platform host** | `DT_PLATFORM_URL` | `https://asn8731h.sprint.apps.dynatracelabs.com` | `Authorization: Bearer dt0s16…` | `/platform/*` — DQL (Grail), dashboards, notebooks, SLOs, synthetic, vulnerabilities |
| **Classic host** | `DT_CLASSIC_URL` | `https://asn8731h.sprint.dynatracelabs.com` | `Authorization: Api-Token dt0c01…` | `/api/v2/*` — settings, metrics, entities, problems, logs (v2) |

---

## Setup

1. **Clone & install:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # then edit .env
   ```
   `.env` is gitignored — never commit it.

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `DT_PLATFORM_URL` | yes | Platform host base URL |
   | `DT_CLASSIC_URL` | yes | Classic host base URL |
   | `DT_PLATFORM_TOKEN` | yes | Bearer token (`dt0s16…`) for platform APIs |
   | `DT_API_TOKEN` | yes | Api-Token (`dt0c01…`) for classic APIs |
   | `DT_ENABLE_WRITES` | no | Set to `true` to allow create/update/delete operations |
   | `DT_HTTP_TIMEOUT_MS` | no | Request timeout in ms (default: 30000) |

---

## Required Token Scopes

### Classic API token (`dt0c01…`)

Needed for settings, metrics, entities, problems:

- `metrics.read`
- `slo.read`, `slo.write`
- `logs.read`
- `settings.read`, `settings.write`
- `entities.read`
- `problems.read`
- `ReadConfig`, `WriteConfig`
- `ExternalSyntheticIntegration` (synthetic read/write)
- `credentialVault.read`

### Platform token (`dt0s16…`)

Needed for DQL/Grail, document APIs, SLOs, synthetic, and vulnerabilities:

- `storage:logs:read`
- `storage:metrics:read`
- `storage:spans:read`
- `storage:entities:read`
- `storage:bizevents:read`
- `storage:events:read`
- `storage:buckets:read`
- `storage:system:read`
- `document:documents:read`, `document:documents:write`
- `document:environment-shares:read`, `document:environment-shares:write`
- `slo:slos:read`, `slo:slos:write`
- `automation:workflows:read` (optional, for synthetic execution)
- `securitySensor:vulnerabilities:read`

---

## Build & Run

```bash
# Install dependencies
npm install

# Build (compiles TypeScript to dist/)
npm run build

# Run the MCP server
node dist/index.js
# or equivalently:
npm start

# Development mode (tsx, no build step)
npm run dev

# Run tests
npm test

# Type-check only (no emit)
npm run typecheck
```

---

## Read-Only by Default

All mutating tools (create, update, delete) check the `enableWrites` config flag. If the flag is `false` (the default), calling any write tool returns an error immediately — no network request is made.

Set `DT_ENABLE_WRITES=true` in your `.env` (or in the MCP client env config) to enable writes. Even then, each destructive tool has its own description noting that it is a write operation.

---

## Tool Catalog

### Observability

| Tool | Description |
|------|-------------|
| `execute_dql` | Execute a DQL statement against Grail |
| `verify_dql` | Validate a DQL statement without returning data |
| `search_logs` | Search logs via DQL |
| `search_spans` | Search spans/traces via DQL |
| `get_trace` | Retrieve a trace by trace ID |
| `list_metrics` | List available metric descriptors |
| `get_metric_metadata` | Get metadata for a specific metric |
| `query_metric` | Query metric data points |
| `list_hosts` | List host entities |
| `find_entities` | Query entities with an entitySelector |
| `get_entity` | Get details for a specific entity |
| `list_entity_types` | List available entity types |
| `list_problems` | List open or recent problems |
| `get_problem` | Get details for a specific problem |
| `list_vulnerabilities` | List security vulnerabilities |
| `get_vulnerability` | Get details for a specific vulnerability |

### Configuration

**Settings (8 tools):** `list_settings_schemas`, `get_settings_schema`, `list_settings_objects`, `get_settings_object`, `validate_settings_object`, `create_settings_object`, `update_settings_object`, `delete_settings_object`

**Dashboards (5 tools):** `list_dashboards`, `get_dashboard`, `create_dashboard`, `update_dashboard`, `delete_dashboard`

**Notebooks (5 tools):** `list_notebooks`, `get_notebook`, `create_notebook`, `update_notebook`, `delete_notebook`

**SLOs (7 tools):** `list_slos`, `get_slo`, `evaluate_slo`, `list_objective_templates`, `create_slo`, `update_slo`, `delete_slo`

**Synthetic (7 tools):** `list_monitors`, `get_monitor`, `list_synthetic_locations`, `list_synthetic_nodes`, `create_monitor`, `update_monitor`, `delete_monitor`

### Notes

- `get_entity` returns relationships and host properties inline, so it covers host-detail and entity-relationship use cases (there are no separate `get_host` / `get_entity_relationships` tools).
- Synthetic location/node tools are named `list_synthetic_locations` / `list_synthetic_nodes`.

---

## MCP Client Registration

Add the following to your MCP client config (Claude Code `~/.claude/mcp.json` or Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dynatrace-saas": {
      "command": "node",
      "args": ["/Users/nasr/mycode/personal/saas-mcp/dist/index.js"],
      "env": {
        "DT_PLATFORM_URL": "https://asn8731h.sprint.apps.dynatracelabs.com",
        "DT_CLASSIC_URL": "https://asn8731h.sprint.dynatracelabs.com",
        "DT_PLATFORM_TOKEN": "dt0s16...",
        "DT_API_TOKEN": "dt0c01...",
        "DT_ENABLE_WRITES": "false"
      }
    }
  }
}
```

Replace the token values with real credentials. Set `DT_ENABLE_WRITES` to `"true"` only if you intend to allow the agent to create or modify Dynatrace configuration.

---

## License

MIT — see [LICENSE](LICENSE).

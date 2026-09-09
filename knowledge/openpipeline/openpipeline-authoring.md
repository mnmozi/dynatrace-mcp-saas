# OpenPipeline — authoring model (objects, routing, groups, how to change it)

How the pieces connect and how to make changes safely through the MCP. On Gen3 builds
OpenPipeline is **Settings 2.0 objects**, so you author it with the generic
`list/get/create/update_settings_object` tools (they auto-validate against the live schema)
— there is no dedicated OpenPipeline-groups tool, and none is needed.

## The object model (per signal type)

Everything is scoped to **one signal type** by schema id. The signal types (scopes):
`bizevents · logs · spans · events · metrics · davis.events · davis.problems ·
security.events · sdlc.events · system.events · smartscape.events · application.snapshots ·
user.events · usersessions`.

For a given `<type>`:

| Object | Schema id | Cardinality | Role |
|---|---|---|---|
| **Pipeline** | `builtin:openpipeline.<type>.pipelines` | multi (≤100) | the stages+processors that transform records (see the processors topic). `displayName`, `customId`, `groupRole`, `routing`. |
| **Routing** | `builtin:openpipeline.<type>.routing` | single | ordered `routingEntries[]` of `{matcher, pipelineId}` deciding which records enter which pipeline; unmatched → the base/default pipeline. |
| **Pipeline group** | `builtin:openpipeline.<type>.pipeline-groups` | multi (≤100) | governance: wrap member pipelines with mandated/restricted stages (see the pipeline-groups topic). |
| **Ingest sources / endpoints** | `builtin:openpipeline.<type>.ingest_sources` (+ related) | — | where data enters. |

**How a record flows:** ingest → **routing** matcher picks a pipeline → the **pipeline**'s
stages run in canonical order → (if the pipeline is a group member) the **group**
composition wraps it → stored / extracted.

`groupRole` on a pipeline: `memberPipeline` (team pipeline, wrapped by a group) ·
`compositionPipeline` (admin pipeline used inside a group composition) · `basePipeline`
(the built-in default). `routing`: `routable` (can be a routing target) / `notRoutable`.

## Making a change — the safe recipe

1. **Read first.** `get_settings_object` (or `list_settings_objects` with the schema id) to
   get the current object + its `objectId`. Routing is a single object — read it, edit
   `routingEntries`, write it back. Pipelines/groups are multi-object — target by objectId.
2. **Author the new value**, grounding on the live schema (`get_settings_schema
   builtin:openpipeline.<type>.pipelines`) for nested attribute shapes.
3. **Dry-run.** `create/update_settings_object` with `dryRun: true` → returns
   `constraintViolations` (bad matcher DQL, unknown processor field, invalid enum, bad
   pipeline reference) **without** writing.
4. **Apply.** Drop `dryRun` (requires `DT_ENABLE_WRITES=true`).
5. **Order matters:** create referenced pipelines BEFORE the routing/group that names them.

## Building a complex pipeline — checklist
- Put transforms (`parse`, `fieldsAdd`, `dql`, lookups) in the **processing** stage; keep
  each processor's `matcher` tight so it only touches the records it should.
- Extract metrics in **metricExtraction** (use the `samplingAware*` variants for spans/RUM).
- Set governance (`securityContext`, `bucketAssignment`, `costAllocation`) in their own
  stages — or centralize them in a **pipeline group** so teams can't override them.
- Route with **routing** matchers; a pipeline does nothing until routing sends records to it.

## Primary Grail tags (a separate pre-routing stage)

`builtin:openpipeline.primary-grail-tag` — *"Global rules for primary Grail tag extraction
and processing during ingest"* (GA, environment scope, multi-object ≤20, **ordered**). This
is NOT part of a pipeline's stages and NOT a pipeline group — it's a **global, pre-routing**
step: rules run at ingest **before** routing picks a pipeline, so the primary tag is available
to routing matchers and downstream. Manage it with the generic settings tools.

Each rule:
- `ruleName` — label.
- `matchingCondition` — DQL expression selecting which records the rule applies to.
- `sourceFields` — an **ordered** list of DQL field expressions; the **first that exists** is
  the source value (≤10, min 1).
- `primaryTagFieldName` — target name in the **`primary_tags`** namespace; **unique** across
  all rules.
- `keepFields` — keep (true) or drop (false) the source field afterward.
- `enabled`.

```jsonc
// builtin:openpipeline.primary-grail-tag  (create/update_settings_object, scope "environment")
{
  "ruleName": "team from k8s namespace",
  "matchingCondition": "isNotNull(k8s.namespace.name)",
  "sourceFields": [ { "fieldExpression": "k8s.namespace.name" }, { "fieldExpression": "app.label.team" } ],
  "primaryTagFieldName": "team",
  "keepFields": true,
  "enabled": true
}
```
Result: records get `primary_tags.team` set from the first present of `k8s.namespace.name` /
`app.label.team`. Because it's pre-routing, a routing entry can then match on it.

Note it writes into `primary_tags.*` on **records** — it is NOT entity security context and
NOT the record `securityContext` processor; it's a distinct tagging mechanism.

> TODO (needs the observed detail): the classic-events **field-flattening** behavior seen when
> ingesting classic-shaped events through OpenPipeline. Capture the exact before/after field
> shape here once confirmed — don't guess it.

## Gotchas that bite
- **Ingest host:** the `/platform/ingest/*` ingest endpoints are DATA-PLANE and served on the
  ENVIRONMENT/classic host (…dynatracelabs.com), NOT the apps host (…apps.dynatracelabs.com) —
  despite the `/platform/` path. `ingest_openpipeline_events` / `raw_post` route through the
  classic client for this reason; the classic API token needs the matching `openpipeline.*` scope.
- **Two scope spellings per ingest endpoint** (same endpoint, by token type): Api-Token uses
  dot-style (`openpipeline.events`, `openpipeline.events_security`); a Platform token uses the
  IAM colon-style (`openpipeline:events:ingest`, `openpipeline:security.events:ingest`). Security
  events' "legacy" vs "new" docs differ ONLY in this auth style — the request path
  `/platform/ingest/v1/security.events` is identical. Don't go hunting for a new path.
- **`event.id` is required** on each ingested event (single object or array); include it or the
  request is rejected. Success is `202` with an empty body — don't wait for a payload.
- **Wrong "language":** matcher vs dql-script are different subsets (see the scripting topic).
- **Migration state:** on some builds the legacy `/platform/openpipeline/v1/configurations`
  API returns "Migration in-progress/completed" and won't accept writes — use the Settings
  2.0 objects above instead. `update_openpipeline_configuration` targets the v1 surface.
- **schemaId hyphens:** it's `pipeline-groups` (hyphen), not `pipeline_groups`.
- **References:** `memberPipelines` / `routingEntries[].pipelineId` / `composition[].pipelineId`
  reference a pipeline's **object id** — create the pipelines first, then use the returned
  ids. (`customId` may resolve on some builds; confirm with a dry-run.)
- **Composition stage inclusion:** a group composition entry only runs the stages in its
  `stages.include`; a `dql` that feeds a later stage must be included too.
- **Reads before writes** — never blind-write routing (it's a single object; you'd clobber
  every other entry). Read, modify `routingEntries`, write back.

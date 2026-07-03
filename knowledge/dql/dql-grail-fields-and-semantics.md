# Grail fields, the semantic dictionary, primary fields, fieldsets & sensitivity

How "schema" actually works in Grail, and how to ground field names before composing DQL.
All facts below were live-verified on a Gen3 tenant.

## The field model (schema-on-read)

- A Grail table has **no fixed schema**. Each record is a bag of field:value pairs; the
  "schema" of a table = the union of whatever fields its records happen to carry.
- Who creates fields (layered):
  1. **Dynatrace, automatic** — core envelope (`timestamp`, `content`, `dt.entity.*`) and
     auto-extraction (`loglevel`, `k8s.*`, `http.*`).
  2. **You, at ingest** — every key in your ingest payload becomes a field verbatim
     (`payment.amount`, `event.data.*` from bizevent capture rules); OpenPipeline DQL
     processors can mint more (stored permanently).
  3. **You, at query time** — `parse`, `fieldsAdd`, `summarize` create fields that exist
     only in the result, never stored.
- **Every pipe stage redefines the field set.** After
  `summarize count(), by:{loglevel}` the stream carries ONLY `loglevel` and `count()`.
  - Gotcha: the aggregate column is literally named `count()`. To filter or sort on it,
    alias it: `summarize c = count(), by:{loglevel} | filter c > 5`.

## The semantic dictionary (queryable reference catalog)

`fetch dt.semantic_dictionary.fields` — Dynatrace's published field conventions
(~1,400 definitions). Columns: `name`, `type`, `stability`, `description`, `tags`,
`examples`, `supported_values`.

- It is a **static Dynatrace-published catalog**. It does NOT reflect your tenant's data:
  custom fields (`payment.*`) never appear in it, and there is **no API to extend it** —
  only Dynatrace platform releases change it.
- **Dictionary ≠ your data**: a field being defined (e.g. `azure.subscription`) doesn't
  mean your records carry it; a field being absent (your custom fields) doesn't mean it
  isn't real. Ground BOTH ways: dictionary for meaning/spelling, sampling for presence.
- Never fetch it raw (1,400 rows). Filter it:

```dql
// meaning + spelling of one field
fetch dt.semantic_dictionary.fields | filter name == "k8s.namespace.name"
| fields name, type, stability, description, examples, tags

// what exists for a domain
fetch dt.semantic_dictionary.fields | filter startsWith(name, "k8s.") | fields name, type

// classification subsets (tags is an ARRAY — expand it before summarize/filter-by-equality,
// or use in("tag", tags) on the array directly)
fetch dt.semantic_dictionary.fields | expand tags
| summarize fields = count(), by:{tags} | sort fields desc
```

## Semantic tags → what actually matters

Only ~124 of the ~1,400 definitions carry tags; those subsets drive platform behavior
(live counts): `smartscape-id` 52, `entity-id` 37, `permission` 15, `primary-field` 10,
`sensitive-spans` 7, `sensitive-user-events` 3.

**Primary fields** (tag `primary-field`, 10 fields): the infrastructure-partition
backbone — `aws.account.id`, `aws.region`, `azure.subscription`, `azure.location`,
`azure.resource.group`, `gcp.project.id`, `gcp.region`, `k8s.cluster.name`,
`k8s.namespace.name`, `dt.host_group.id`. Normalized consistently across ALL tables;
most also tagged `permission` (IAM policies can condition on them, e.g. "may only read
records where k8s.namespace.name == 'team-a'"). Always safe to filter/group by.

Naming your custom fields to match dictionary entries (like `event.category`) inherits
platform semantics for free; unmatched names (`payment.*`) work fine but are semantically
unknown to the platform.

## Fieldsets (curated field groups — metadata only)

- A fieldset = named list of field names with `scope` (TABLE/BUCKET/TENANT) — a
  classification/grouping mechanism, NOT a live catalog of existing fields and NOT data.
- Dynatrace ships read-only builtins (`createdBy: dynatrace-internal`, `readOnly: true`)
  that materialize the sensitive-field tags: `builtin-sensitive-spans` (tables: spans),
  `builtin-sensitive-user-events-and-sessions` (user.events/user.sessions).
- Users CAN create their own (grouping PII fields, team column presets) — but whether
  custom fieldsets get the builtins' automatic read-time enforcement is UNVERIFIED;
  don't assume it.

## Sensitivity & masking — scope and tiers

- The builtin sensitive classification is **per-table**: `client.ip` is protected on
  `spans` / RUM tables only. The same field name on `logs` inherits NOTHING.
- Even where it applies, it's **read-time field-level security** — the value is stored
  raw; users without the fine-grained permission see it masked. Admin tokens see it.
- To protect a field yourself, pick the tier by goal:
  1. **Never reaches Dynatrace**: `builtin:oneagent.side.masking.settings` (OneAgent-side).
  2. **Stored masked** (usual default): `builtin:logmonitoring.sensitive-data-masking-settings`
     (logs), `builtin:attribute-masking` (span/request attributes), or an OpenPipeline DQL
     processor (`fieldsAdd f = hashSha256(f)` / `fieldsRemove f`) — hashing keeps
     group-by/joinability while destroying the value.
  3. **Stored raw, access-gated**: `dt.security_context` + IAM record-level policies.
- You CANNOT add `sensitive-*` tags to the semantic dictionary (Dynatrace-only).

## Field-discovery recipe (probe-first grounding)

1. **Dictionary** for the domain → correct spellings + semantics
   (`startsWith(name, "k8s.")`).
2. **Sample your table** → which fields actually exist, incl. custom ones:
   `fetch <table>, from:now()-24h | limit 5` (or a wider limit; a sample can still miss
   rare fields — treat as "observed in window", not complete).
3. Compose filters only on fields seen in step 2, spelled per step 1; `verify_dql` is
   the final backstop.

# OpenPipeline — processors & stages reference

Everything you can put in a pipeline. A pipeline (`builtin:openpipeline.<type>.pipelines`)
is a set of **stages**; each stage is a list of **processors**; each processor has a
`type`, an `enabled` flag, a DQL `matcher` (which records it acts on), and one
type-specific attribute object. Author these via `create/update_settings_object` (they
auto-validate). For the exact nested shape of any attribute, call
`get_settings_schema` on the pipelines schema — this doc is the map, the live schema is
the territory.

## Processor skeleton (every processor)

```jsonc
{
  "type": "<processorType>",     // one of the 25 below
  "enabled": true,
  "matcher": "true",             // DQL matcher — see the scripting topic; "true" = all records
  "description": "…",
  "<attrKey>": { … }             // the attribute object; key == a per-type name (table below)
}
```

## The 10 stages and which processors go in each

Stages run per record in this **canonical order** (regardless of how you list them):
`processing → securityContext → costAllocation → productAllocation → storage →
smartscapeNodeExtraction → smartscapeEdgeExtraction → metricExtraction → davis →
dataExtraction`. A processor lives in the stage whose `processors[]` array you put it in.

| Stage | Processor `type` (attr key) | What it does |
|---|---|---|
| **processing** | `fieldsAdd` (fieldsAdd) | add/replace a field from an expression |
| | `fieldsRemove` (fieldsRemove) | drop fields |
| | `fieldsRename` (fieldsRename) | rename fields |
| | `dql` (dql) | run a DQL processing **script** (the powerful one — parse, multi-field, functions) |
| | `technology` (technology) | apply a technology bundle's parsing (customMatcher / technologyId) |
| | `drop` (—) | drop the whole record (matcher decides which) |
| | `geoLookup` (geoLookup) | enrich an IP field → geo fields (ipFieldKey, geoFieldPrefix, outputFields) |
| | `inlineLookup` (inlineLookup) | map a source field → destination via an inline table (+ defaultValue) |
| **securityContext** | `securityContext` (securityContext) | set `dt.security_context` (value = constant / field / multiValueConstant) |
| **costAllocation** | `costAllocation` (costAllocation) | stamp a cost key (value assignment) |
| **productAllocation** | `productAllocation` (productAllocation) | stamp a product-allocation key (value assignment) |
| **storage** | `bucketAssignment` (bucketAssignment) | route the record to a Grail bucket (bucketName) |
| | `noStorage` (—) | process but do **not** store (e.g. metrics-only extraction) |
| **smartscapeNodeExtraction** | `smartscapeNode` (smartscapeNode) | extract a Smartscape node (nodeType, id components, name, fields) |
| **smartscapeEdgeExtraction** | `smartscapeEdge` (smartscapeEdge) | extract a Smartscape edge (source/target type + id fields) |
| **metricExtraction** | `counterMetric` (counterMetric) | count matching records into a metric (metricKey, dimensions) |
| | `valueMetric` (valueMetric) | extract a numeric field into a metric (metricKey, field, dimensions) |
| | `histogramMetric` (histogramMetric) | histogram of a numeric field |
| | `samplingAwareCounterMetric` / `samplingAwareValueMetric` / `samplingAwareHistogramMetric` | as above, corrected for span/RUM sampling (adds sampling, aggregation, measurement) |
| **davis** | `davis` (davis) | emit a Davis event (properties list) |
| **dataExtraction** | `bizevent` (bizevent) | extract a business event (eventType, eventProvider, fieldExtraction) |
| | `sdlcEvent` (sdlcEvent) | extract an SDLC event (type, provider, category, status, fieldExtraction) |
| | `securityEvent` (securityEvent) | extract a security event (fieldExtraction) |
| | `azureLogForwarding` (azureLogForwarding) | forward to an Azure forwarder (forwarderConfigId, fieldExtraction) |

25 processor types total. Not every type exists for every signal (e.g. `bizevent`
extraction lives on log/event pipelines, not on the bizevents pipeline itself) — the live
schema for each `builtin:openpipeline.<type>.pipelines` is authoritative.

## Attribute shapes (the type-specific object)

```jsonc
fieldsAdd:      { "fields": [ { "name": "app", "value": "orders-web" } ] }   // value is TEXT; use dql for expressions
fieldsRemove:   { "fields": [ "tmp", "debug.raw" ] }
fieldsRename:   { "fields": [ { "from": "msg", "to": "content" } ] }
dql:            { "script": "parse content, \"...DPL...\" \n| fieldsAdd n = arraySize(x)" }
technology:     { "customMatcher": "…", "technologyId": "nginx" }
geoLookup:      { "ipFieldKey": "client.ip", "geoFieldPrefix": "client.geo.", "outputFields": ["country","city"] }
inlineLookup:   { "sourceField": "code", "destinationField": "code.name", "inlineLookupTable": "…", "defaultValue": "unknown" }
securityContext:{ "value": { "type": "constant", "constant": "prod-orders" } }        // or type:"field"/"multiValueConstant"
costAllocation: { "value": { "type": "field", "field": { "sourceFieldName": "team", "defaultValue": "shared" } } }
bucketAssignment:{ "bucketName": "bizevents_orders" }
counterMetric:  { "metricKey": "orders.count", "dimensions": ["app","region"] }
valueMetric:    { "metricKey": "orders.amount", "field": "amount", "defaultValue": "0", "dimensions": ["app"] }
histogramMetric:{ "metricKey": "orders.latency", "field": "latency", "defaultValue": "0", "dimensions": ["app"] }
bizevent:       { "eventType": {…}, "eventProvider": {…}, "fieldExtraction": {…} }     // get_settings_schema for nested refs
```

## Value assignment (`GenericValueAssignment`) — used by securityContext / cost / product

Three modes:
- `{ "type": "constant", "constant": "prod-orders" }` — a fixed string.
- `{ "type": "field", "field": { "sourceFieldName": "orders.zone", "defaultValue": "unclassified" } }` — take a **whole field's** value, with a fallback.
- `{ "type": "multiValueConstant", "multiValueConstant": ["a","b"] }` — a fixed list.

There is **no** concat/substring in the assignment itself. To compute a value from *parts*
of the record, add a `dql` processor upstream (`fieldsAdd zone = concat("prod-", lower(region))`)
and then reference that field with `type: "field"`.

## Gotchas
- **Matcher runs on the record as-is at that stage.** A field a later stage/processor adds
  isn't available to an earlier matcher (canonical stage order above).
- **In a pipeline group's composition**, only the stages listed in that entry's
  `stages.include` run. If your `dql` computes a field the `securityContext` stage needs,
  the composition entry must `include` BOTH `processing` and `securityContext`.
- **`fieldsAdd.value` is plain text** — for expressions/functions use a `dql` processor.
- **`drop` / `noStorage`** have no attribute object; the `matcher` is the whole config.

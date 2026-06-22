# DQL Skill — Agent Playbook for Dynatrace Grail (Gen3/SaaS)

Single-file, action-ready DQL playbook. Distilled from the 5 reference docs (cross-referenced for
depth). Validated live on a Gen3/Grail tenant (`asn8731h.sprint`).

**Depth references:** `dql-reference.md` (feature reference, 21 §) · `dql-metrics-and-self-monitoring.md`
(metrics/SFM/billing) · `dql-k8s-investigation.md` (k8s) · `dql-business-cases.md` (worked scenarios) ·
`dql-filter-after-summarize-bug.md` (the fold bug in depth).

---

## 1. Quick-start

**How to run DQL.** Tools are deferred — load schemas first via `ToolSearch` with
`select:mcp__dynatrace-saas__execute_dql,mcp__dynatrace-saas__verify_dql`, then:
- `mcp__dynatrace-saas__verify_dql` — validate query shape WITHOUT executing (use to catch 400s cheaply).
- `mcp__dynatrace-saas__execute_dql` — run the query and get rows back.

**Pipeline model.** A query is a source then commands joined by `|`. Each stage takes the previous
table and emits a new one. Order matters. Comments: `// line` or `/* block */`. Field names can
contain dots (`batch.job.group.name`) — they are flat names, not nested objects.

```dql
<source>
| command1 ...
| command2 ...
```

**Timeframes.** Relative to `now()`. `from:`/`to:` on the source: `fetch logs, from: now()-2h`,
`from: now()-24h, to: now()-1h`, `from: @d` (start of today).

**Strings are DOUBLE-QUOTED only.** `'single'` is a syntax error (except DPL literals inside a `parse`
pattern, which use single quotes). In JSON payloads escape inner quotes (`\"`).

**No `let`/variables in-query.** Reuse values via chained `fieldsAdd`. Dashboard/notebook `$vars` are
substituted *before* the query runs (a raw API call with an unbound `$x` errors).

---

## 2. Data-surface map — valid `fetch` targets

| `fetch` target | Use it for | Notes |
|---|---|---|
| `fetch logs` | log records | timeframe required |
| `fetch spans` | distributed tracing / request analysis | ids need `toString()` — see GOTCHAS |
| `fetch bizevents` | app-emitted business events, trace-linked | `event.kind == "BIZ_EVENT"` |
| `fetch events` | Davis problems, anomalies, fleet events | `event.kind` ∈ {DAVIS_PROBLEM, DAVIS_EVENT, FLEET_EVENT} |
| `fetch metric.series` | metric **catalog/metadata** (one row per series) | NOT values — use `timeseries` for values |
| `fetch dt.entity.host` (`.service`, `.process_group`, `.cloud_application`, k8s entities…) | monitored entities | request attrs explicitly; invalid attr errors whole query |
| `data record(...)` | inline/synthetic data for tests & docs | not a live source |

**Metric VALUES** come from `timeseries` / `makeTimeseries`, never `fetch`.

**NOT fetchable (hard 400):**
- **`fetch dt.slo.*`** — no Grail SLO surface. Use MCP tools `list_slos` / `evaluate_slo` /
  `list_objective_templates`, or compute the SLI via `timeseries` over `dt.service.request.*`.
- **Classic Metrics v2 API** (`list_metrics`, `get_metric_metadata`) — gone on Gen3 (needs `metrics.read`).
  Discover metrics via `fetch metric.series | summarize by: {metric.key}` instead.

---

## 3. Command reference (compact)

| Need | Command |
|---|---|
| Source | `fetch …` / `data record(…)` / `timeseries …` |
| Keep / drop rows | `filter <cond>` / `filterOut <cond>` |
| Keep-only / add / drop cols | `fields a, b=expr` / `fieldsAdd x=expr` / `fieldsRemove a` |
| Aggregate | `summarize agg…, by: {…}` |
| Order / cap / unique | `sort f desc` / `limit N` / `dedup key` |
| Enrich (left-join, no fan-out) | `lookup [..], lookupField:, sourceField:, prefix:` |
| Relational join | `join [..], on: {k}, kind:, fields: {…}` |
| Union | `append [..]` |
| Branch | `if(c, a, else: b)`, `coalesce(a, b, …)` |
| Parse text | `parse field, "<DPL>"` |
| Explore schema / values | `describe <src>` / `fieldsSummary f1, f2` |
| Bucket into series | `timeseries` (metrics) / `makeTimeseries` (records) |

**filter operators/predicates:** `== != < <= > >=`, `AND OR NOT`; `contains()` (small text only — see
GOTCHAS), `startsWith()`, `endsWith()`, `in(field,"a","b")`, `matchesValue()`, `matchesPhrase(text,"…")`,
`isNull()`, `isNotNull()`.

**fields family:** `fields` keeps ONLY listed (drops the rest, supports rename/compute); `fieldsAdd`
appends/overwrites and keeps the rest; `fieldsRemove` drops named.

**summarize:** with `by:{…}` → one row per group; **without `by:` → exactly ONE row even over empty
input** (`count()`→0). Aggregations: `count()`, `countDistinct(f)`, `countIf(cond)`, `sum/avg/min/max/
median/percentile(f, N)`, `takeFirst/takeAny/takeMax(f)`, `collectArray(f)`.

**lookup vs join:**

| | `lookup` (enrich) | `join` (relational) |
|---|---|---|
| Match | first match only | all matches (fans out 1-to-many) |
| Row count | never grows | can grow |
| Keys | `lookupField:`/`sourceField:` | `on: {k}` (identically-named on both sides) |
| Right cols | all, with `prefix:` | `fields: {…}` subset, else all as `right.*` |

- **Valid `kind:` = `inner`, `leftOuter`, `outer` only.** No `rightOuter` (swap operands + `leftOuter`).
- **Anti-join:** `join … kind: leftOuter | filter isNull(rightcol)`. **Semi-join:** `lookup … | filter isNotNull(r_col)`.
- **Always use a real `prefix:`** (e.g. `"d_"`); `prefix:""` lets nulls overwrite your main fields on no-match.
- `on:` is mandatory (no implicit cross join). Multi-key `on: {region, dept}` = AND. Cross join = add a
  constant key to both sides.

**parse (DPL):** literals in **single quotes**, `:name` binds a capture. Matchers: `WORD` (incl `_`),
`INT/LONG/DOUBLE` (typed), `LD` (lazy "anything", stops at next literal), `TIMESTAMP('fmt')`, `IPADDR`,
`SPACE`, `EOL`. Alternation `('ERROR'|'WARN'):level`; optional group `(' role=' WORD:role)?`. No
match → fields `null`, **row kept** (parse never drops). `stringLength` (not `strLen`).

**JSON:** no `parseJson()`. Use the DPL `JSON` matcher: `parse payload, "JSON:obj"` → nested record.
Access with backtick keys: `obj[`meta`][`host`]`. `fieldsFlatten obj` lifts one level to dotted names.
`expand` a nested array into rows.

**arrays (0-based):** `array(...)`, `arraySize/arrayFirst/arrayLast/arraySum/arrayAvg/arrayMax/arrayMedian/arrayPercentile`,
`steps[1]`, `in(value, array)`, `arrayContains`. `expand arr` → one row per element; `collectArray(f)`
in summarize is the inverse.

**conditionals:** `if(cond, then, else: elseV)` (nestable); `coalesce(a, b, …)` = first non-null.

**time/math:** `duration` is a **duration type** → convert with unit division `/1ms /1s /1m /1h /1d`
(NEVER `/1000000`). `now()-2h`, `end-start`, `ts+30m`. `toTimestamp("18:30+04")` anchors to today.
`formatTimestamp(ts, format:, timezone:)`. **`round(x, decimals: N)`** — named param required. Force
float division with `* 100.0`.

**timeseries vs makeTimeseries:** both emit array-per-series rows (`{timeframe, interval, <agg>:[…]}`,
`null`=empty bucket). `timeseries` reads metric keys (time implicit); `makeTimeseries` buckets
record/log rows (needs explicit `time: <field>`). Both split with `by: {…}`, support multiple aggs, and
take `filter: {…}`.

---

## 4. GOTCHAS & RULES (read before writing any query)

| # | Rule | WRONG | RIGHT |
|---|---|---|---|
| 1 | **THE FOLD BUG** — a `filter` right after `summarize` whose predicate folds to a compile-time constant is silently pushed ABOVE the summarize, emptying input and emitting a phantom `count=0` row. | `\| summarize n=count() \| fieldsAdd s="no" \| filter s=="yes"` → 1 phantom row | filter on a real aggregate (`\| filter count < 1`), keep `count` in the predicate, or isolate the summarize in a `lookup` subquery |
| 2 | **`sort:` as a named param inside `summarize`** → opaque 400. | `summarize …, sort: x` | separate stage: `\| summarize … \| sort x desc` |
| 3 | **`join` needs identically-named keys aliased on BOTH subqueries** — not equality expressions. | `join [..], on: { a == b }` | `\| fields joinkey=toString(span.id), … \| join [ … \| fields joinkey=toString(span.parent_id), child=… ], on: {joinkey}, fields:{child}` |
| 4 | **`contains()` on a large TEXT or ARRAY field** → 400. | `contains(event.description, "x")` / `contains(affected_entity_names, "x")` | text: `matchesPhrase(event.description, "x")`; array: `expand` it then `==`, or `in`/`arrayContains` |
| 5 | **trace/span ids are NOT strings** — `==`/`join`/`lookup` return 0 rows unless wrapped. | `filter trace.id == "85ac…"` | `fieldsAdd tid=toString(trace.id) \| filter tid=="85ac…"` |
| 6 | **`round` requires named `decimals:`** | `round(x, 2)` → 400 | `round(x, decimals: 2)` |
| 7 | **`duration` is a duration type** — convert by unit division. | `avg(duration)/1000000` → 400 | `avg(duration)/1ms` |
| 8 | **`percentile`/`median` as a `timeseries` aggregation on gauges return 0 rows** (no error). Works fine in `summarize` over raw events. | `timeseries p95=percentile(m,95)` → empty | build `avg` series, reduce array: `arrayPercentile(cpu, 95)` |
| 9 | **boolean span fields group into THREE buckets**: true/false/**null**. Mind the denominator. | assume `request.is_failed` = 2 values | decide how `null` counts; `countIf(request.is_failed==true)` for the numerator |
| 10 | **`service.name` is null for OneAgent-detected services**; dual OTel+OneAgent instrumentation makes duplicate service entities. | group by `service.name` | use `dt.entity.service` as the canonical key |
| 11 | **OTel topology: parent→child self-join across OTel/OneAgent can break.** | `span.parent_id → span.id` self-join | derive caller→callee from CLIENT-span attrs: `server.address`, `db.system` + `server.address:port` |
| 12 | **No `fetch dt.slo.*`** (hard 400). | `fetch dt.slo.…` | MCP `list_slos`/`evaluate_slo`/`list_objective_templates`, or compute SLI via `timeseries` over `dt.service.request.*` |
| 13 | **Davis problems are a STREAM of status rows.** `event.kind` has 3 values (DAVIS_PROBLEM/DAVIS_EVENT/FLEET_EVENT). | filter a constant field after summarize (bug #1) | dedup by `display_id` or `countDistinct(display_id)` |
| 14 | **k8s pod/container counts: `count()` of series or `sum`, never `avg`** (gauge is 1 per pod). | `avg(dt.kubernetes.pods)` → "1 per ns" | `fetch metric.series \| summarize count(), by:{…}` |
| 15 | **`get_openpipeline_configuration` returns the SPEC** (allowed processor types), not concrete instances. | read it for actual routing | `dt.openpipeline.pipelines` is an array → `summarize by:{dt.openpipeline.pipelines}` |
| 16 | **DIAGNOSTIC DISCIPLINE** — an opaque `400: request failed` can be a transient backend outage (the `timeseries` metric path had one), NOT a query-shape bug. | "fix" a query that was never broken | re-run a known-good control of the SAME kind (`fetch spans \| summarize count()`) to isolate subsystem (timeseries vs fetch vs data) before concluding |
| — | **invalid entity/metric attribute names error the whole query**; **`describe`/`fieldsSummary` first.** | guess attr names | `describe dt.entity.host` → `fieldsSummary f` → real query |

---

## 5. Recipe library (copy-paste)

**Service error rate (spans):**
```dql
fetch spans, from: now()-30m
| summarize requests = count(), failed = countIf(request.is_failed == true), by: {dt.entity.service}
| fieldsAdd error_rate_pct = round((failed * 100.0) / requests, decimals: 2)
| filter requests > 50
| sort error_rate_pct desc
```

**Latency percentiles (root spans = requests):**
```dql
fetch spans, from: now()-30m
| filter request.is_root_span == true
| summarize p50_ms = round(percentile(duration, 50)/1ms, decimals: 1),
            p95_ms = round(percentile(duration, 95)/1ms, decimals: 1),
            p99_ms = round(percentile(duration, 99)/1ms, decimals: 1),
            calls  = count(),
            by: {dt.entity.service}
| sort p95_ms desc
```

**Trace drill-down (toString ids):**
```dql
fetch spans, from: now()-1h
| fieldsAdd tid = toString(trace.id), sid = toString(span.id), pid = toString(span.parent_id)
| filter tid == "85ac9fa520673382913dcec10e9060cb"
| fields start_time, service.name, span.name, ms = duration/1ms, span.kind, db.system, sid, pid
| sort start_time asc
```

**Service topology via CLIENT spans (reliable caller→callee):**
```dql
fetch spans, from: now()-30m
| filter span.kind == "client"
| summarize calls = count(), by: {caller = dt.entity.service, callee = server.address}
| sort calls desc
```

**SLA breach board (fold-safe, multi-job):**
```dql
data
  record(bjg = "IB_CTOFF_ACTIVATEX", sla = "18:30+04"),
  record(bjg = "IB_SOD_LOADX",       sla = "06:00+04"),
  record(bjg = "IB_EOD_SETTLEX",     sla = "22:00+04")
| lookup [                                  -- prod: fetch logs | filter Success | summarize cnt=count(), by:{bjg}
    data record(bjg="IB_CTOFF_ACTIVATEX"), record(bjg="IB_CTOFF_ACTIVATEX"), record(bjg="IB_SOD_LOADX")
    | summarize cnt = count(), by: {bjg}
  ], lookupField: bjg, sourceField: bjg, prefix: "lk_"
| fieldsAdd count = coalesce(lk_cnt, 0)
| fieldsAdd sla_status = if(count >= 1, "pass", else: if(now() > toTimestamp(sla), "fail", else: "pending"))
| filter sla_status == "fail"               -- safe: predicate depends on runtime `count`
```

**Davis problems — dedup + RCA:**
```dql
fetch events, from: now()-24h
| filter event.kind == "DAVIS_PROBLEM"
| dedup display_id
| fields display_id, event.name, event.category, event.status, affected_entity_names, event.description
| sort event.status asc
```
(Count distinct problems: `| summarize problems = countDistinct(display_id), by: {event.category}`.)

**Metric cardinality check (before an expensive `by:`):**
```dql
fetch metric.series, from: now()-1h
| summarize series = count(), by: {metric.key}
| sort series desc | limit 15
```

**Top-N by reduced array (rank noisy series):**
```dql
timeseries cpu = avg(dt.host.cpu.usage), by: {host.name}, from: now()-2h
| fieldsAdd p95 = round(arrayPercentile(cpu, 95), decimals: 1), peak = round(arrayMax(cpu), decimals: 1)
| sort p95 desc | limit 10
```

**k8s workload CPU / throttle / memory:**
```dql
-- CPU
timeseries cpu = avg(dt.kubernetes.container.cpu_usage), by: {k8s.namespace.name, k8s.workload.name}, from: now()-1h
| fieldsAdd cpu_avg = round(arrayAvg(cpu), decimals: 4) | sort cpu_avg desc | limit 10
-- Throttle (perf signal)
timeseries thr = avg(dt.kubernetes.container.cpu_throttled), by: {k8s.workload.name}, from: now()-1h
| fieldsAdd throttle = round(arrayAvg(thr), decimals: 4) | filter throttle > 0 | sort throttle desc
-- Memory vs limit (saturation)
timeseries used = avg(dt.kubernetes.container.memory_working_set), lim = avg(dt.kubernetes.container.limits_memory),
           by: {k8s.workload.name}, from: now()-1h
| fieldsAdd pct_of_limit = round((arrayAvg(used) * 100.0) / arrayAvg(lim), decimals: 1)
| filter isNotNull(pct_of_limit) | sort pct_of_limit desc
```

**Pods per namespace (count series, not avg):**
```dql
fetch metric.series, from: now()-30m
| filter metric.key == "dt.kubernetes.pods"
| summarize pods = count(), by: {k8s.namespace.name}
| sort pods desc
```

**Compute an SLI (no SLO fetch surface):**
```dql
timeseries { total = sum(dt.service.request.count), failures = sum(dt.service.request.failure_count) },
  by: {dt.entity.service}
| fieldsAdd sli_pct = round(((arraySum(total) - arraySum(failures)) / arraySum(total)) * 100, decimals: 3)
| sort sli_pct asc
```

**Entity-name enrichment (id → human name):**
```dql
timeseries cpu = avg(dt.host.cpu.usage), by: {dt.entity.host}, interval: 30m
| lookup [ fetch dt.entity.host | fields id, name = entity.name ],
    lookupField: id, sourceField: dt.entity.host, prefix: "h_"
| fields host = h_name, cpu
```

---

*All patterns derive from live-verified queries on `asn8731h.sprint`. For full worked scenarios,
deeper feature notes, and the complete fold-bug write-up, see the 5 source docs referenced at the top.*

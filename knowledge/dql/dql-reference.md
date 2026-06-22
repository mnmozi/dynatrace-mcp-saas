# DQL (Dynatrace Query Language) — Practical Reference

A hands-on reference built from queries **executed live** on a Dynatrace Grail tenant
(`asn8731h.sprint`, 2026-06-18). Every example here was run and its output verified.

> Tip: every example uses `data record(...)` so you can paste and run it anywhere — no dependency
> on logs existing in your tenant. In production you'd swap `data record(...)` for a real source
> like `fetch logs`, `fetch spans`, `fetch events`, `fetch dt.entity.host`, or `timeseries`.

---

## 1. The pipeline model

A DQL query is a **pipeline**: a data source, then a series of commands joined by `|`. Each command
takes the table of records from the previous stage and produces a new table.

```dql
<source>
| command1 ...
| command2 ...
```

- Records flow top to bottom. Order matters.
- Comments: `// line` or `/* block */`.
- Field names can contain dots (`batch.job.group.name`) — they're flat names, not nested objects.

### Data sources

| Source | Use |
|--------|-----|
| `fetch logs` / `fetch spans` / `fetch events` / `fetch bizevents` | real Grail data |
| `fetch dt.entity.host` (etc.) | monitored entities |
| `timeseries` | metrics |
| `data record(...)` | inline/synthetic data — great for testing & docs |

```dql
data
  record(name = "alice", dept = "eng",   salary = 100, active = true),
  record(name = "bob",   dept = "eng",   salary = 120, active = false),
  record(name = "carol", dept = "sales", salary = 90,  active = true)
```
→ 3 records, fields `name, dept, salary, active` (string, string, long, boolean).

### Timeframes

`fetch logs` takes a timeframe; everything is relative to `now()`:

```dql
fetch logs, from: now() - 2h               // last 2 hours
fetch logs, from: now() - 24h, to: now() - 1h
fetch logs, from: @d                        // @d = start of today
```

---

## 2. Filtering — `filter`, `filterOut`

`filter` keeps rows where the condition is **true**; `filterOut` is its inverse.

```dql
data record(name="alice", dept="eng"), record(name="bob", dept="sales"), record(name="carol", dept="eng")
| filter dept == "eng"
```
→ alice, carol.

```dql
... | filterOut dept == "eng"        // -> only bob
```

**Operators:** `==  !=  <  <=  >  >=`, `AND`, `OR`, `NOT`.
**Useful predicates:** `contains(field, "x")`, `startsWith()`, `endsWith()`, `in(field, "a", "b")`,
`matchesValue()`, `isNull(field)`, `isNotNull(field)`.

```dql
| filter dept == "eng" AND salary > 100
| filter in(dept, "eng", "ops")
| filter contains(content, "ERROR")
```

> ⚠️ **Gotcha:** never `filter` on a *constant-valued* field immediately after a `summarize` — it can
> be silently dropped. See §11 and `dql-filter-after-summarize-bug.md`.

---

## 3. Shaping fields — `fields`, `fieldsAdd`, `fieldsRemove`

| Command | Effect |
|---------|--------|
| `fields a, b = expr` | keep **only** these (drops everything else); supports rename/compute |
| `fieldsAdd x = expr` | **append** new/overwrite fields, keep the rest |
| `fieldsRemove a, b` | drop specific fields |

```dql
data record(name = "alice", dept = "eng", salary = 100)
| fieldsAdd raise = salary * 1.1     // adds 'raise' = 110, keeps name/dept/salary
| fields employee = name, raise      // keeps ONLY employee(renamed) + raise
```
→ `{ employee: "alice", raise: 110 }`.

```dql
data record(name="alice", dept="eng", secret="x")
| fieldsRemove secret                 // -> { name, dept }
```

---

## 4. Aggregation — `summarize`

Collapses rows into aggregates. With `by: {…}` you get one row per group; without it, **exactly one
row total** (even over zero input rows — important!).

```dql
data
  record(dept="eng", salary=100), record(dept="eng", salary=120),
  record(dept="sales", salary=90), record(dept="sales", salary=110), record(dept="sales", salary=95)
| summarize headcount = count(),
            total    = sum(salary),
            avg      = avg(salary),
            lowest   = min(salary),
            highest  = max(salary),
            by: {dept}
```
→ `eng: {2, 220, 110, 100, 120}`, `sales: {3, 295, 98.33, 90, 110}`.

### Aggregate functions

| Function | Meaning |
|----------|---------|
| `count()` | row count (0 over empty input) |
| `countDistinct(f)` | distinct values |
| `countIf(cond)` | count rows matching a condition |
| `sum / avg / min / max / median / percentile(f, 95)` | numeric aggregates |
| `takeFirst / takeAny / takeMax(f)` | pick a value |
| `collectArray(f)` | gather values into an array |

```dql
data record(dept="eng", lvl="sr"), record(dept="eng", lvl="jr"), record(dept="eng", lvl="sr"), record(dept="sales", lvl="jr")
| summarize total = count(),
            distinct_levels = countDistinct(lvl),
            seniors = countIf(lvl == "sr"),
            by: {dept}
```
→ `eng: {3, 2, 2}`, `sales: {1, 1, 0}`.

> **Key fact:** `summarize` with no `by` always emits **one row**, even when the input is empty
> (`count()` → 0). This is what makes "0 successes today" detectable — and also what produces the
> phantom row in the §11 bug.

---

## 5. Sorting & limiting — `sort`, `limit`, `dedup`

```dql
data record(name="alice", score=80), record(name="bob", score=95), record(name="carol", score=95), record(name="dave", score=70)
| sort score desc
| limit 2
```
→ bob(95), carol(95).

`dedup` keeps the **first** row per key (combine with `sort` to control which "first"):

```dql
data record(job="A", status="ok", ts=1), record(job="A", status="fail", ts=2), record(job="B", status="ok", ts=3)
| sort ts desc
| dedup job
```
→ `A: fail (ts2)`, `B: ok (ts3)` — newest per job.

---

## 6. Joining data — `lookup`, `join`, `append`

### `lookup` — left-join an enrichment table (most common)

```dql
data record(name="alice", dept="eng"), record(name="bob", dept="sales"), record(name="zoe", dept="ops")
| lookup [
    data record(dept="eng", manager="Erin"), record(dept="sales", manager="Sam")
  ], lookupField: dept, sourceField: dept, prefix: "d_"
| fieldsAdd manager = coalesce(d_manager, "UNASSIGNED")
| fields name, dept, manager
```
→ alice→Erin, bob→Sam, zoe→UNASSIGNED (no match → looked-up fields are null).

- `lookupField` = key in the **subquery**, `sourceField` = key in the **main** stream.
- **Always set a real `prefix:`** (e.g. `"d_"`). With `prefix: ""`, looked-up fields overwrite your
  main fields with `null` on a no-match.

### `join` — explicit join with a `kind`

```dql
data record(name="alice", dept="eng"), record(name="bob", dept="sales"), record(name="zoe", dept="ops")
| join [
    data record(dept="eng", manager="Erin"), record(dept="sales", manager="Sam")
  ], on: {dept}, kind: leftOuter, fields: {manager}
```
→ same rows; `zoe.manager = null`. `kind:` supports `inner`, `leftOuter`, etc. `fields: {…}` picks
which columns to bring in.

### `append` — stack datasets vertically (union)

```dql
data record(name="alice", src="A")
| append [ data record(name="bob", src="B"), record(name="carol", src="B") ]
```
→ 3 rows (alice/A, bob/B, carol/B).

---

## 7. Conditionals

`if(condition, thenValue, else: elseValue)`, nestable for multi-branch logic:

```dql
data record(v=10), record(v=20), record(v=30)
| fieldsAdd bucket = if(v < 15, "low", else: if(v < 25, "mid", else: "high"))
```
→ 10→low, 20→mid, 30→high.

`coalesce(a, b, …)` returns the first non-null:

```dql
| fieldsAdd manager = coalesce(d_manager, "UNASSIGNED")
```

---

## 8. String functions

| Function | Example → result |
|----------|------------------|
| `concat(a, b, …)` | `concat("x-", s)` → `"x-Batch Job failed"` |
| `upper(s)` / `lower(s)` | `"BATCH JOB FAILED"` / `"batch job failed"` |
| `contains(s, "fail")` | `true` |
| `stringLength(s)` | `stringLength("hello")` → `5` |
| `substring(s, from: 0, to: 5)` | `"Batch"` (0-based, `to` exclusive end index) |
| `splitString(s, ",")` | `"a,b,c"` → `["a","b","c"]` (array) |
| `replaceString(s, "failed", "ok")` | `"job failed"` → `"job ok"` |

> `strLen` does **not** exist — the function is `stringLength`.

---

## 9. Time & math functions

```dql
data record(start = toTimestamp("2026-06-18T08:00:00+04:00"),
            end   = toTimestamp("2026-06-18T08:45:30+04:00"))
| fieldsAdd
    duration     = end - start,                 // a duration (nanoseconds internally)
    duration_min = (end - start) / 1m,          // -> 45.5  (divide by a time unit)
    day          = formatTimestamp(start, format: "yyyy-MM-dd", timezone: "Asia/Dubai"),
    rounded      = round(98.7654, decimals: 2), // -> 98.77
    absval       = abs(-42)                      // -> 42
```

- **`toTimestamp("18:30+04")`** is valid — DQL anchors a time-only string to *today* (→ `14:30Z`).
- Durations are nanoseconds; divide by a unit literal (`1s`, `1m`, `1h`, `1d`) to convert.
- Time math: `now() - 2h`, `end - start`, `timestamp + 30m`.
- `formatTimestamp(ts, format:, timezone:)` for display; `Asia/Dubai` = +04.

---

## 10. Timeseries — `makeTimeseries`

Buckets records into fixed intervals over the query timeframe, returning an **array per series**:

```dql
data
  record(t = now()-50m, v=10), record(t = now()-40m, v=20),
  record(t = now()-12m, v=30), record(t = now()-5m,  v=40)
| makeTimeseries avg_v = avg(v), time: t, interval: 15m
```
→ one row: `{ timeframe, interval: 15m, avg_v: [null, null, …, 10, 20, 30, 40] }`.

For metrics you'd normally start from `timeseries cpu = avg(dt.host.cpu.usage), interval: 1m` instead.

---

## 11. The big gotcha — `filter` dropped after `summarize`

A `filter` immediately after a `summarize`, whose predicate the optimizer can fold to a constant, is
**silently relocated above the `summarize`** — emptying the input and emitting a phantom `count = 0`
row that ignores the filter.

```dql
data record(a=1), record(a=2), record(a=3)
| summarize s = sum(a), n = count()
| fieldsAdd label = "no"
| filter label == "yes"
-- expected 0 rows; ACTUAL: 1 row { s: null, n: 0 }   <-- input emptied, filter ignored
```

**Avoid it:**
- Filter on a real aggregate column: `| filter count < 1` (never folds).
- Or keep `count` in the outer branch: `if(count >= 1, "pass", else: …)` then filter the result.
- Or move the `summarize` into a `lookup` subquery so the filter isn't after an aggregation.

**Detect it:** the returned row's filtered field must equal the value you filtered on. Mismatch (filter
`"fail"` → row shows `"pass"`/`false`) = the bug. Full write-up: `dql-filter-after-summarize-bug.md`.

---

## 12. Parsing — `parse` (DPL)

Extract structured fields from text using Dynatrace Pattern Language (DPL) matchers. Literals go in
**single quotes**; `:name` binds a capture to a field.

**Full structured parse** of a batch-job log line:
```dql
data record(raw = "2026-06-18 08:45:30 ERROR host-07 job=IB_CTOFF_ACTIVATEX rc=12 dur=45.5")
| parse raw, "TIMESTAMP('yyyy-MM-dd HH:mm:ss'):ts ' ' WORD:level ' ' LD:host ' job=' LD:job ' rc=' INT:rc ' dur=' DOUBLE:dur"
| fields ts, level, host, job, rc, dur
```
→ `{ ts: 2026-06-18T08:45:30Z, level: "ERROR", host: "host-07", job: "IB_CTOFF_ACTIVATEX", rc: 12, dur: 45.5 }`

### Common matchers

| Matcher | Matches | Notes |
|---------|---------|-------|
| `WORD` | word chars **including `_`** | captured `IB_CTOFF_ACTIVATEX` whole |
| `INT` / `LONG` / `DOUBLE` | numbers | typed (not string) |
| `LD` | "line data" — anything, **lazy** | stops at the next literal |
| `TIMESTAMP('fmt')` | a timestamp | returns a real timestamp type |
| `IPADDR`, `SPACE`, `EOL` | ip / whitespace / end | |

### Behaviors worth knowing (all verified)

- **`LD` is lazy** — `parse raw, "LD 'rc=' INT:rc LD"` skips any prefix and grabs `rc` from the middle
  of the line.
- **Alternation** `('ERROR'|'WARN'):level` — matches either literal.
- **Optional group** `(' role=' WORD:role)?` — captures when present, `null` when absent.
- **No match → fields are `null`, but the row is kept** (parse never drops rows). A `DEBUG` line run
  through an `('ERROR'|'WARN')` pattern yields `level: null`.

```dql
-- skip prefix, grab middle:    "...junk... rc=99 ..."  ->  rc = 99
| parse raw, "LD 'rc=' INT:rc LD"

-- optional field:              "user=bob"  ->  { user:"bob", role:null }
| parse raw, "'user=' WORD:user (' role=' WORD:role)?"
```

> Tip: to drop non-matching rows, follow `parse` with `| filter isNotNull(level)`.

---

## 13. Arrays

Build with `array(...)`; access and aggregate with `array*` functions; index is **0-based**.

```dql
data record(job = "IB_CTOFF_ACTIVATEX", steps = array("extract","transform","load"), durs = array(10,20,30))
| fieldsAdd
    n_steps   = arraySize(steps),     // 3
    first     = arrayFirst(steps),    // "extract"
    last      = arrayLast(steps),     // "load"
    second    = steps[1],             // "transform"  (0-based)
    total_dur = arraySum(durs),       // 60
    avg_dur   = arrayAvg(durs)        // 20
```

**`expand`** — explode an array into one row per element (other fields are duplicated):
```dql
data record(job = "IB_CTOFF_ACTIVATEX", steps = array("extract","transform","load"))
| expand steps          // -> 3 rows; 'steps' is now a scalar per row
```

**`collectArray`** in `summarize` — the inverse: gather rows into an array per group:
```dql
data record(job="A", step="extract"), record(job="A", step="load"), record(job="B", step="extract")
| summarize steps = collectArray(step), by: {job}     // A:[extract,load], B:[extract]
```

**Membership** — `in(value, array)`:
```dql
| fieldsAdd has_load = in("load", steps)    // true / false
```

> `expand` + `summarize ... collectArray` are a round-trip pair: flatten an array to process per
> element, then regroup. Handy for per-step analysis of a job that logs all its steps in one record.

---

## 14. JSON & nested data

There is **no `parseJson()` function**. Parse a JSON string with the DPL **`JSON` matcher**:

```dql
data record(payload = "{\"recordsProcessed\":1500,\"meta\":{\"host\":\"host-07\",\"env\":\"prod\"}}")
| parse payload, "JSON:obj"
```
→ `obj` is a nested record: `{ recordsProcessed: 1500, meta: { host: "host-07", env: "prod" } }`.

**Access nested fields** with backtick keys; chain for depth:
```dql
| fieldsAdd recs = obj[`recordsProcessed`],
            host = obj[`meta`][`host`]      // -> 1500, "host-07"
```

**`fieldsFlatten`** lifts nested fields to dotted top-level names — **one level at a time**:
```dql
| fieldsFlatten obj
-- -> obj.recordsProcessed = 1500,  obj.meta = { host, env }   (meta still nested; flatten again for deeper)
```

**Expand a nested array** into rows:
```dql
data record(payload = "{\"job\":\"IB_CTOFF_ACTIVATEX\",\"errors\":[\"timeout\",\"retry\",\"db_lock\"]}")
| parse payload, "JSON:obj"
| fieldsAdd job = obj[`job`], errs = obj[`errors`]
| expand errs            // -> 3 rows: timeout / retry / db_lock
```

> **String literals are double-quoted only** — `'single'` is a syntax error. For JSON payloads, escape
> the inner double quotes (`\"`).

---

## 15. Timeseries — `timeseries` (metrics) vs `makeTimeseries` (records)

Both produce the **array-per-series** shape: each output row is one series with a `timeframe`,
`interval`, and one value **array per aggregation**, aligned to the time buckets (`null` = no data).

### `timeseries` — query metrics directly

```dql
timeseries cpu = avg(dt.host.cpu.usage), by: {dt.entity.host}, interval: 10m, from: now()-1h
```
→ one row per host, each with a `cpu: [..]` array. `by:` splits into multiple series. You can request
several aggregations: `timeseries load = avg(m), peak = max(m), interval: 5m`.

### `makeTimeseries` — bucket event/log records into a series

Use when your data is rows with a timestamp (logs, bizevents, synthetic `data`):

```dql
data
  record(t = now()-50m, job="A", recs=100), record(t = now()-45m, job="A", recs=150),
  record(t = now()-50m, job="B", recs=10),  record(t = now()-10m, job="B", recs=40)
| makeTimeseries total = sum(recs), by: {job}, time: t, interval: 15m
```
→ series for job A and job B, each `total: [.., 100, 150, .., null]`.

| | `timeseries` | `makeTimeseries` |
|---|--------------|------------------|
| Source | metrics (`dt.*` metric keys) | event/log/record rows |
| Time field | implicit (metric timestamps) | explicit `time: <field>` |
| Split into series | `by: {…}` | `by: {…}` |
| Multiple aggregations | yes | yes |

> The value is an **array**, not a scalar. To get back to rows (e.g. to post-process), there are
> helpers, but for charting/dashboards the array shape is exactly what tiles consume.

---

## 16. Variables & reuse

DQL has **no in-query variable/`let` binding**. There are two real mechanisms:

**1. Reuse within a query — chained `fieldsAdd`.** Compute a value once; later stages reference it:
```dql
data record(processed = 950, failed = 50)
| fieldsAdd total      = processed + failed
| fieldsAdd error_rate = (failed * 100.0) / total      // references 'total'
| fieldsAdd health     = if(error_rate < 5, "ok", else: "degraded")   // references 'error_rate'
```
→ `total=1000, error_rate=5, health="degraded"`. (Note: use `100.0` not `100` to force float division.)

**2. Parameterization — dashboard/notebook variables (`$name`).** These are **not** part of DQL — the
dashboard or notebook substitutes them *before* the query runs. A raw API call with `$threshold` and no
binding **errors**. In a dashboard you'd write:
```dql
fetch logs | filter bjg == "$jobName" | summarize count = count()
```
and define `jobName` as a dashboard variable (text, or a `csv`/query-backed list). For multi-value
variables use `in(bjg, $jobNames)` or `matchesValue(bjg, {$jobNames})`.

> Takeaway: inside one query, lean on `fieldsAdd` chaining. To make a query reusable across
> jobs/environments, lift the changing literals into dashboard variables.

---

## 17. Entity queries — `fetch dt.entity.*`

Monitored entities (hosts, services, process groups, …) are queryable tables. `fetch dt.entity.host`
returns `id` + `entity.name` by default; request more attributes explicitly:

```dql
fetch dt.entity.host
| fields id, entity.name, ipAddress, osType, cpuCores
```
→ `{ id: "HOST-…", entity.name: "ip-…", ipAddress: ["172.28.192.216", …], osType: "LINUX", cpuCores: 1 }`
(note `ipAddress` is an **array**). Invalid attribute names error the whole query, so add fields you know.

**Filter / count** like any table:
```dql
fetch dt.entity.host | filter contains(entity.name, "eu-central-1") | summarize hosts = count()
```

**Enrich metrics or logs with the human name** — the single most useful entity pattern. Metrics carry
the entity *id* (`dt.entity.host`); join it to the entity table to get the name:
```dql
timeseries cpu = avg(dt.host.cpu.usage), by: {dt.entity.host}, interval: 30m
| lookup [ fetch dt.entity.host | fields id, name = entity.name ],
    lookupField: id, sourceField: dt.entity.host, prefix: "h_"
| fields host = h_name, cpu
```
→ each series now labelled with `ip-172-28-…` instead of `HOST-ABDE…`.

> Other entity types follow the same shape: `fetch dt.entity.service`, `fetch dt.entity.process_group`,
> `fetch dt.entity.cloud_application` (Kubernetes), etc. Relationships are exposed as fields on the
> entity; request the specific relationship attribute by name rather than a generic `entityAttr(...)`.

---

## 18. Exploration & subqueries

When you don't know the data, two commands map it fast.

**`describe <source>`** — the schema: every field and its type. Use it to find valid attribute names
before you `fields`/`filter` (invalid names error the whole query):
```dql
describe dt.entity.host
-- -> field / data_types rows: bitness(string), lifetime(timeframe), belongs_to(record=relationship), gcpZone(string), …
```

**`fieldsSummary f1, f2`** — per-field cardinality + value distribution (the "what's in here?" tool):
```dql
fetch dt.entity.host | fieldsSummary osType, cpuCores
-- -> osType: {rawCount 4, distinct 1, values:[{LINUX,4}]},  cpuCores: {values:[{1,4}]}
```

**Subqueries `[ … ]`** are full pipelines, not just table names. They power `lookup`/`join`/`append`,
and can filter/`expand`/shape inside:
```dql
data record(host_ip = "172.28.192.216"), record(host_ip = "10.0.0.1")
| lookup [
    fetch dt.entity.host
    | filter osType == "LINUX"
    | expand ipAddress              // flatten the IP array so each IP is joinable
    | fields ipAddress, name = entity.name
  ], lookupField: ipAddress, sourceField: host_ip, prefix: "m_"
| fieldsAdd matched_host = coalesce(m_name, "UNKNOWN")
```
→ `172.28.192.216 → ip-172-28-192-216…`, `10.0.0.1 → UNKNOWN`.

> Workflow tip: `describe` to learn the fields → `fieldsSummary` to see their values → then write the
> real query. Beats guessing attribute names and eating 400s.

---

## 19. Joins — deep dive (how far they go)

Everything here was enumerated by live testing. DQL gives you two join tools — `lookup` (enrichment)
and `join` (relational) — plus `append` (union).

### `lookup` vs `join` — the critical difference is **cardinality**

| | `lookup` | `join` |
|---|----------|--------|
| Match policy | **first match only** | **all matches** |
| Row count | never grows (safe enrichment) | **fans out** on one-to-many |
| Keys | `lookupField:` / `sourceField:` | `on: {…}` |
| Right columns | all, with your `prefix:` | `fields: {…}` subset, or all as `right.*` |

One left row + two right matches: `lookup` → **1 row** (first), `join` → **2 rows** (fan-out). Use
`lookup` to attach attributes; use `join` when you genuinely want the relational product.

### Valid `kind:` values — only **`inner`, `leftOuter`, `outer`**

```dql
| join [ <subquery> ], on: {dept}, kind: leftOuter, fields: {mgr}
```

| kind | keeps | supported? |
|------|-------|-----------|
| `inner` | matched rows only | ✅ |
| `leftOuter` | all left + matched right (null fill) | ✅ |
| `outer` | all left **and** all right (full outer) | ✅ |
| `rightOuter` | — | ❌ **not supported** → swap operands + `leftOuter` |
| `leftAnti` / `leftSemi` / `rightAnti` | — | ❌ **not supported** → use workarounds below |

### Anti-join & semi-join (workarounds)

```dql
-- ANTI-JOIN: left rows with NO match  ->  leftOuter then filter the null
| join [ ... ], on: {dept}, kind: leftOuter, fields: {mgr}
| filter isNull(mgr)

-- SEMI-JOIN: left rows that HAVE a match (no right cols, no fan-out) -> lookup + filter
| lookup [ ... ], lookupField: dept, sourceField: dept, prefix: "r_"
| filter isNotNull(r_mgr)
```

### Keys, multi-key, and cross joins

- **`on:` is mandatory** — there is no implicit cross join.
- **Multi-key:** `on: {region, dept}` matches on all listed fields (AND).
- **Cross/cartesian** (when you really want it): add a constant key to both sides and join on it:
  ```dql
  data record(a=1), record(a=2) | fieldsAdd k = 1
  | join [ data record(b="x"), record(b="y") | fieldsAdd k = 1 ], on: {k}, kind: inner, fields: {b}
  -- -> 4 rows (2 x 2)
  ```

### `fields:` and `prefix:` on `join`

- `fields: {m}` → bring just `m`, **unprefixed**.
- **Omit `fields:`** → bring **all** right columns, prefixed `right.*` (`right.m`, `right.n`).
- `join` also accepts `prefix:` to namespace the brought-in columns.

### Composability

- **Chained joins** accumulate columns: `… | join A | join B` (A→managers, B→region).
- The join/lookup right side is a **full subquery** — `filter`/`expand`/`summarize` inside it.
- **Cross-source**: join real `fetch dt.entity.*` data to synthetic/hosted tables (e.g. tag hosts
  from an ownership table) — verified joining 4 real hosts to a metadata table.

> Rule of thumb: **`lookup` for "add columns, don't change row count"; `join` for "relate two sets,
> fan-out allowed."** Need a right-outer or anti/semi? Reshape with operand-swap or `isNull`/`isNotNull`.

---

## 20. Spans / distributed tracing — `fetch spans`

Spans are a first-class Grail table — full request-level analysis in DQL. Each span carries trace/span
ids, timing, k8s/host context, and rich HTTP/RPC attributes.

**Key fields:** `trace.id`, `span.id`, `span.parent_id`, `duration` (a **duration type**), `service.name`,
`endpoint.name`, `span.name`, `span.kind`, `request.is_root_span`, `request.is_failed`,
`dt.failure_detection.verdict`, `http.request.method`, `http.route`, `http.response.status_code`.

**Service error rates:**
```dql
fetch spans, from: now()-30m
| summarize requests = count(), failed = countIf(request.is_failed == true), by: {service.name}
| fieldsAdd error_rate_pct = round((failed * 100.0) / requests, decimals: 2)
| filter requests > 50
| sort error_rate_pct desc
```

**Latency percentiles** (root spans = requests). Note `percentile()` **does** work in `summarize`
(unlike `timeseries`), and convert the `duration` type with **time-unit division `/1ms`**:
```dql
fetch spans, from: now()-30m
| filter request.is_root_span == true
| summarize p50_ms = round(percentile(duration, 50)/1ms, decimals: 1),
            p95_ms = round(percentile(duration, 95)/1ms, decimals: 1),
            p99_ms = round(percentile(duration, 99)/1ms, decimals: 1),
            calls  = count(),
            by: {service.name}
| sort p95_ms desc
```

**Top endpoints, slowest first:**
```dql
fetch spans, from: now()-30m
| filter request.is_root_span == true
| summarize calls = count(), avg_ms = round(avg(duration)/1ms, decimals: 1), by: {service.name, endpoint.name}
| sort avg_ms desc | limit 20
```

**Trace drill-down** — all spans of one trace, ordered. ⚠️ `trace.id`/`span.id`/`span.parent_id` are
**NOT plain strings** — a direct `== "…"` silently returns **0 rows**. Wrap in `toString()` first:
```dql
fetch spans, from: now()-1h
| fieldsAdd tid = toString(trace.id), sid = toString(span.id), pid = toString(span.parent_id)
| filter tid == "85ac9fa520673382913dcec10e9060cb"
| fields start_time, service.name, span.name, ms = duration/1ms, span.kind, db.system, sid, pid
| sort start_time asc
```
The span tree shows where latency lives: in the demo, a `/api/orders` request (~4.5s) is ~89% a single
`SELECT orders` PostgreSQL client span (~4.0s) inside `payment-service` — one slow query, not contention.

### ⚠️ Gotchas this section exposed
- **`round` needs the named `decimals:` parameter** — `round(x, decimals: 1)` ✅, `round(x, 1)` ❌
  (positional second arg → `400: request failed`). This bit every duration/percentage query until fixed.
- **`duration` is a duration type** — convert with **time-unit division** (`/1ms`, `/1s`, `/1m`), not a
  plain number. `avg(duration)/1000000` errors; `avg(duration)/1ms` gives milliseconds.
- **ID fields aren't strings** — `trace.id`/`span.id`/`span.parent_id` need `toString()` before `==` or
  `join`/`lookup`; otherwise 0 rows (looks like a backend issue but isn't — verified the engine was up first).
- **`request.is_failed` has THREE buckets** when grouped: `true`, `false`, **and `null`** (spans not
  classified as requests). Don't assume boolean = 2 values; decide how `null` counts in a denominator.
- **`percentile()` placement** — works in `summarize` over raw events, but returns 0 rows as a
  `timeseries` aggregation on gauges (use `arrayPercentile` there — see metrics doc §7).

---

## 21. Business events, Davis problems & SLOs

### `fetch bizevents` — business events
Application-emitted business events, trace-linked. Fields: `event.type`, `event.provider`,
`event.category`, `event.kind` (`BIZ_EVENT`), `event.id`, plus `trace.id`/`span.id` correlation and
HTTP/k8s context.
```dql
fetch bizevents, from: now()-3h
| summarize count(), by: {event.type, event.provider, event.category}
```
→ in the demo: `order.attempt` (1744), `payment.attempt` (1339), category `checkout`. These tie business
volume to traces — join to `fetch spans` on `toString(trace.id)` to connect a payment attempt to its latency.

### `fetch events` — Davis problems, anomalies, fleet events
```dql
fetch events, from: now()-24h | summarize count(), by: {event.kind}
```
`event.kind` has **three** values here: `DAVIS_PROBLEM`, `DAVIS_EVENT`, **`FLEET_EVENT`** (don't forget
the third). Davis problems carry full RCA:
```dql
fetch events, from: now()-24h
| filter event.kind == "DAVIS_PROBLEM"
| summarize count(), by: {event.name, event.category, event.status}
```
Fields: `display_id` (e.g. `P-2606202`), `event.name`, `event.category` (SLOWDOWN/ERROR), `event.status`
(ACTIVE/CLOSED), `event.description` (markdown RCA), `affected_entity_*`, `dt.davis.*`. In the demo the
top problems are "Failure rate increase" and "Response time degradation" on the api-gateway service.

### SLOs — NOT a `fetch` surface
There is **no `fetch dt.slo.*`** Grail bucket — every `dt.slo*` / `dt.davis.slo` target hard-`400`s
(confirmed not transient via a known-good control). Instead:
- **MCP tools**: `list_slos` (this tenant: 0 configured), `list_objective_templates` (14 built-in),
  `evaluate_slo`, `create_slo`.
- **Compute the SLI directly** with `timeseries` over service metrics, e.g. availability:
  ```dql
  timeseries { total = sum(dt.service.request.count), failures = sum(dt.service.request.failure_count) },
    by: {dt.smartscape.service}
  | fieldsAdd sli = ((arraySum(total) - arraySum(failures)) / arraySum(total)) * 100
  ```

| Surface | `fetch` target | Status here |
|---------|----------------|-------------|
| Business events | `fetch bizevents` | ✅ 3k/3h |
| Davis problems/events | `fetch events` | ✅ DAVIS_PROBLEM/DAVIS_EVENT/FLEET_EVENT |
| SLOs | — (no fetch target) | use `list_slos`/`evaluate_slo` or compute SLI via `timeseries` |

---

## Quick command cheat-sheet

| Need | Command |
|------|---------|
| Source data | `fetch …` / `data record(…)` / `timeseries …` |
| Keep matching rows | `filter` / `filterOut` |
| Add/keep/drop columns | `fieldsAdd` / `fields` / `fieldsRemove` |
| Aggregate | `summarize … , by: {…}` |
| Order / cap / unique | `sort` / `limit` / `dedup` |
| Enrich (left join) | `lookup [...], lookupField:, prefix:` |
| Join with kind | `join [...], on:, kind:, fields:` |
| Union | `append [...]` |
| Branch | `if(c, a, else: b)`, `coalesce(...)` |
| Extract from text | `parse field, "<DPL>"` |
| Bucket into series | `makeTimeseries` / `timeseries` |

---

*All examples verified live on tenant `asn8731h.sprint`. Note: this tenant currently has **0 logs**, so
`fetch logs` returns empty there — examples use `data record(...)` for reproducibility.*

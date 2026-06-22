# DQL Metrics Catalog, Dimensions & Self-Monitoring

How to discover metrics, learn their parameters (dimensions/cardinality), and decide how far you can
group them. Verified live on `asn8731h.sprint` (a SaaS-demo EKS tenant — **299 metrics**).

---

## 1. There is no classic Metrics API on Gen3

`list_metrics` / `get_metric_metadata` (classic Metrics v2) are **gone** — they need `metrics.read`
which Grail tenants don't have. Everything is DQL-native:

| Goal | Command |
|------|---------|
| List metric keys | `fetch metric.series \| summarize by: {metric.key}` |
| See a metric's dimensions | `fetch metric.series \| filter metric.key == "…" \| limit 1` |
| Query values over time | `timeseries x = avg(<key>), by: {…}, interval:, from:` |
| Count distinct metrics | `fetch metric.series \| summarize countDistinct(metric.key)` |

`fetch metric.series` is the **catalog**: one record per *series* (a metric + one unique dimension
combination). Its fields are `metric.key` plus every dimension that series carries.

---

## 2. Discover the catalog

```dql
fetch metric.series, from: now()-3h
| summarize series = count(), by: {metric.key}     // series = cardinality (how many dimension combos)
| sort metric.key asc
```

Metric families on this tenant:

| Family | What it is | Examples |
|--------|-----------|----------|
| `dt.host.*` | **default infrastructure** (OneAgent host) | `dt.host.cpu.usage`, `dt.host.memory.used`, `dt.host.disk.used.percent`, `dt.host.net.nic.bytes_rx` |
| `dt.containers.*` | container CPU/memory | `dt.containers.cpu.usage_user_time`, `dt.containers.memory.resident_set_bytes` |
| `dt.kubernetes.*` | k8s workloads | `dt.kubernetes.container.cpu_usage`, `dt.kubernetes.container.oom_kills` |
| `dt.runtime.*` | tech runtimes | `dt.runtime.nginx.traffic`, `dt.runtime.nginx.connections.waiting` |
| **`dt.sfm.*`** | **self-monitoring** (Dynatrace monitoring itself) | see §4 |
| **`dt.billing.*`** | **cost / consumption** | `dt.billing.full_stack_monitoring.usage`, `dt.billing.logs.ingest.usage_by_product` |

---

## 3. Parameters: dimensions & how far you can group

A metric's **groupable dimensions = the non-`metric.key` fields on its series**. Inspect one series:

```dql
fetch metric.series, from: now()-1h
| filter metric.key == "dt.host.cpu.usage"
| limit 1
```
`dt.host.cpu.usage` carries ~20 dimensions, e.g.:
`dt.entity.host`, `host.name`, `aws.region`, `aws.availability_zone`, `aws.resource.id`,
`dt.entity.ec2_instance`, `dt.entity.kubernetes_cluster`, `dt.entity.kubernetes_node`,
`k8s.cluster.name`, `k8s.node.name`, `dt.metrics.source`, …

**Group by any subset — single or multi-dimension:**
```dql
timeseries cpu = avg(dt.host.cpu.usage),
  by: {host.name, aws.availability_zone, k8s.cluster.name},
  interval: 30m, from: now()-1h
```
→ one series per unique combination (here 4 hosts across 3 AZs in cluster `saas-demo-eks`).

**Cardinality = the `series` count.** A metric with `series = 1` has no useful split (e.g. each
`dt.billing.*` is a single number); `dt.containers.cpu.*` has `series = 97` (per container). Grouping
by a high-cardinality dimension produces that many lines — mind the chart/cost blow-up.

**Filter before/within the query** to scope:
```dql
timeseries cpu = avg(dt.host.cpu.usage), by: {host.name},
  filter: { aws.availability_zone == "eu-central-1a" }
```

---

## 4. Self-monitoring — `dt.sfm.*`

"SFM" = Dynatrace self/full monitoring: the platform watching its own components. Useful families:

| Sub-family | Watches |
|------------|---------|
| `dt.sfm.active_gate.jvm.*` | ActiveGate JVM heap, GC, CPU |
| `dt.sfm.active_gate.system.*` | ActiveGate host CPU/memory |
| `dt.sfm.active_gate.communication.*` | messages dropped/rejected/resent, queue usage |
| `dt.sfm.active_gate.kubernetes.*` | k8s API query count/duration, cache, events |
| `dt.sfm.active_gate.rest.*` | request/response count, size, time |
| `dt.sfm.extension.engine.*_ingest.*` | extension **metric/log/event ingest** lines sent vs **rejected** |
| `dt.sfm.grail.bucket.size` | Grail storage per bucket |
| `dt.sfm.host.os_process_stats.*` | OneAgent process counts |

Example — extension ingest health (sent vs rejected is a great quality signal):
```dql
timeseries sent = sum(dt.sfm.extension.engine.metric_ingest.lines_sent),
           rejected = sum(dt.sfm.extension.engine.metric_ingest.lines_rejected),
           interval: 1h, from: now()-6h
```

---

## 5. Cost / consumption — `dt.billing.*`

Single-series counters (no dimension split). Sum the array for a total:
```dql
timeseries usage = sum(dt.billing.full_stack_monitoring.usage), from: now()-24h
| fieldsAdd total = arraySum(usage)        // e.g. 271.25 FSM units / 24h
```
Others: `infrastructure_monitoring.usage`, `kubernetes_monitoring.usage`,
`logs.ingest.usage_by_product`, `logs.ingest.usage_by_costcenter`, `traces.ingest.usage_by_product`.
Use `_by_costcenter` / `_by_product` variants when you need the split.

---

## 6. Choosing metrics — a method, not a guess

1. **`fetch metric.series | summarize by:{metric.key}`** → see what exists.
2. **Inspect one series** of a candidate → learn its dimensions and whether it splits the way you need.
3. **Check cardinality** (`series` count) → know how many lines a `by:` will produce.
4. **`timeseries … by:{…}`** with the dimensions that match your grouping goal.
5. For platform health pick `dt.sfm.*`; for cost pick `dt.billing.*`; for infra pick `dt.host.*` /
   `dt.kubernetes.*`.

> Rule: **the dimensions on the series are exactly how far you can group** — no more, no less. If the
> split you want isn't a field on the series, that metric can't give it to you; find another metric or
> enrich via `lookup` to an entity table.

---

## 7. Metric querying patterns (tested)

### Aggregations inside `timeseries`
`avg`, `sum`, `min`, `max`, `count` work directly:
```dql
timeseries load = avg(dt.host.cpu.usage), peak = max(dt.host.cpu.usage), by: {host.name}
```

### ⚠️ Percentiles: reduce the array, don't aggregate
`percentile(metric, percentile: 95)` and `median(metric)` as **timeseries aggregations return 0 rows**
on plain gauges (no error — just empty). Instead build an `avg` series and reduce the **value array**:
```dql
timeseries cpu = avg(dt.host.cpu.usage), by: {host.name}, from: now()-2h
| fieldsAdd p95    = round(arrayPercentile(cpu, 95), decimals: 1),
            median = round(arrayMedian(cpu), decimals: 1),
            peak   = round(arrayMax(cpu), decimals: 1)
| sort p95 desc
```
Array reducers (`arrayAvg`, `arrayMax`, `arrayMedian`, `arrayPercentile`, `arraySum`) turn a series
into a scalar — the key to **ranking** series (top-N noisy hosts, etc.).

### Cross-metric math
Two metrics in one `timeseries`, then combine (force float with `* 100.0`):
```dql
timeseries sent     = sum(dt.sfm.extension.engine.metric_ingest.lines_sent),
           rejected = sum(dt.sfm.extension.engine.metric_ingest.lines_rejected),
           from: now()-6h, interval: 1h
| fieldsAdd reject_rate_pct = round((arraySum(rejected) * 100.0) / (arraySum(sent) + arraySum(rejected)), decimals: 3)
```
→ ingest reject rate (0% = healthy).

### Scope with `filter:` and split with `by:`
```dql
timeseries cpu = avg(dt.host.cpu.usage), by: {host.name},
  filter: { aws.availability_zone == "eu-central-1a" }
```

### Reading the output
Every `timeseries` row = one series: `{ timeframe, interval, <metric>: [values…] }`. Empty buckets are
`null`. For a dashboard, hand the array straight to a chart tile; for a table/alert, reduce it to a
scalar with an `array*` function first.

---

## 8. Catalog analysis without `timeseries`

`fetch metric.series` is a **normal table** — `filter`/`summarize`/`countDistinct`/`join` all work on
it. This means you can analyze the metric estate **without querying any data points** (and it keeps
working even if the `timeseries` data path is temporarily unavailable).

**Cardinality ranking — which metrics are "heavy" (most series):**
```dql
fetch metric.series, from: now()-1h
| summarize series = count(), by: {metric.key}
| sort series desc | limit 15
```
e.g. `dt.runtime.nodejs.memory.*` ≈ 1,746 series, `dt.process.*` ≈ 140 — grouping these by a
high-cardinality dimension produces that many lines. **Check cardinality here before running an
expensive `timeseries by: {…}`.**

**Dimension census — how many distinct values exist (= the realistic grouping breadth):**
```dql
fetch metric.series, from: now()-1h
| filter startsWith(metric.key, "dt.kubernetes")
| summarize workloads = countDistinct(k8s.workload.name),
            namespaces = countDistinct(k8s.namespace.name),
            pods = countDistinct(k8s.pod.name)
```

**Series breakdown by dimension** (e.g. container metrics per namespace + workload kind):
```dql
fetch metric.series, from: now()-1h
| filter metric.key == "dt.kubernetes.container.cpu_usage"
| summarize series = count(), by: {k8s.namespace.name, k8s.workload.kind}
| sort series desc
```

> **Robustness lesson:** if a `timeseries` query returns `400: request failed`, re-run a *known-good*
> query of the same kind. If `fetch metric.series` and `data record(...)` still work but `timeseries`
> doesn't, the **metric data-point path is the problem, not your query** — don't "fix" a query that was
> never broken. Isolate the subsystem (timeseries vs fetch vs data) before concluding anything.

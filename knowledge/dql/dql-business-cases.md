# DQL Business Cases — Bank Batch-Job Platform

Worked, **live-tested** DQL scenarios for a scheduled batch-job platform. Companion to
`dql-reference.md` (feature reference). Examples use `data record(...)` to simulate logs/metrics so they
run anywhere; in production swap the synthetic sources for `fetch logs` / `timeseries`.

Domain model: jobs (`bjg`) run on a schedule, emit log lines + JSON payloads, have **SLA cutoff
times**, run on hosts, and process records.

---

## BC1 — Multi-job SLA breach report

**Need:** one query that watches every job's SLA: `pass` (ran), `pending` (not due yet), `fail`
(missed and past cutoff). Built fold-safe (see reference §11) — `sla_status` keys off `count`, and the
aggregation is isolated in a `lookup` subquery.

```dql
data                                          -- driver table: the jobs + their SLA cutoffs
  record(bjg = "IB_CTOFF_ACTIVATEX", sla = "18:30+04"),
  record(bjg = "IB_SOD_LOADX",       sla = "06:00+04"),
  record(bjg = "IB_EOD_SETTLEX",     sla = "22:00+04")
| lookup [                                    -- success counts (prod: fetch logs | filter Success)
    data record(bjg="IB_CTOFF_ACTIVATEX"), record(bjg="IB_CTOFF_ACTIVATEX"), record(bjg="IB_SOD_LOADX")
    | summarize cnt = count(), by: {bjg}
  ], lookupField: bjg, sourceField: bjg, prefix: "lk_"
| fieldsAdd count = coalesce(lk_cnt, 0)
| fieldsAdd sla_status = if(count >= 1, "pass",
                       else: if(now() > toTimestamp(sla), "fail", else: "pending"))
| fields bjg, sla, count, sla_status
| sort sla_status asc
```

→ ACTIVATEX `pass` (count 2), SOD_LOAD `pass` (count 1), SETTLE `fail` (count 0, past 22:00+04).

**Breach-only alert** — append `| filter sla_status == "fail"` (safe: `sla_status` depends on `count`).

**Production swap:** replace the `lookup [...]` subquery with:
```dql
| lookup [
    fetch logs, from: @d
    | filter service == "Batch Job Group" AND job_status == "Success"
    | summarize cnt = count(), by: {bjg}
  ], lookupField: bjg, sourceField: bjg, prefix: "lk_"
```

**Features used:** `data` driver table · `lookup` subquery · `coalesce` · nested `if` · `filter` ·
`sort`. **Scales** by adding driver rows.

---

## BC2 — Top failing jobs (last 24h)

**Need:** rank jobs by failure count, with the worst return code and a sample of codes seen.

```dql
data                                          -- prod: fetch logs, from:@d
  record(raw="2026-06-18 08:00:01 ERROR job=IB_CTOFF_ACTIVATEX rc=12"),
  record(raw="2026-06-18 08:05:00 ERROR job=IB_CTOFF_ACTIVATEX rc=8"),
  record(raw="2026-06-18 08:10:00 INFO job=IB_SOD_LOADX rc=0"),
  record(raw="2026-06-18 08:15:00 ERROR job=IB_EOD_SETTLEX rc=5"),
  record(raw="2026-06-18 08:20:00 ERROR job=IB_CTOFF_ACTIVATEX rc=1"),
  record(raw="2026-06-18 08:25:00 ERROR job=IB_EOD_SETTLEX rc=9")
| parse raw, "TIMESTAMP('yyyy-MM-dd HH:mm:ss'):ts ' ' WORD:level ' job=' WORD:job ' rc=' INT:rc"
| filter level == "ERROR"
| summarize failures = count(), worst_rc = max(rc), sample_rcs = collectArray(rc), by: {job}
| sort failures desc
| limit 5
```
→ ACTIVATEX: 3 failures, worst 12, [12,8,1]; SETTLE: 2, worst 9, [5,9]. (`INFO` line excluded.)

**Features used:** `parse` (DPL) · `filter` · `summarize` (count/max/collectArray) · `sort` · `limit`.

---

## BC3 — Throughput & error-rate trends

**A. Throughput over time, per job** (for a chart tile):
```dql
data                                          -- prod: fetch logs | parse recordsProcessed
  record(t=now()-50m, job="A", recs=100), record(t=now()-40m, job="A", recs=120), record(t=now()-20m, job="A", recs=80),
  record(t=now()-50m, job="B", recs=200), record(t=now()-10m, job="B", recs=150)
| makeTimeseries throughput = sum(recs), by: {job}, time: t, interval: 15m
```
→ one series per job; values bucketed to the interval.

**B. Error-rate % per job** — `countIf` over `count`, forced float division, rounded:
```dql
data
  record(job="A", status="ok"), record(job="A", status="ok"), record(job="A", status="fail"),
  record(job="B", status="ok"), record(job="B", status="fail"), record(job="B", status="fail"), record(job="B", status="fail")
| summarize total = count(), errors = countIf(status == "fail"), by: {job}
| fieldsAdd error_rate_pct = round((errors * 100.0) / total, decimals: 1)
| sort error_rate_pct desc
```
→ B: 75% (3/4), A: 33.3% (1/3).

**Features used:** `makeTimeseries` (`by:`, `time:`, `interval:`) · `summarize` (`countIf`) ·
float arithmetic (`* 100.0`) · `round`. Watch the `100.0` — integer `100` would truncate the rate.

---

## BC4 — Enriched incident table

**Need:** turn raw breaches into an on-call-ready table — owner team, criticality, runbook, and a
one-line page summary.

```dql
data                                          -- prod: the BC1 breaches (filter sla_status=="fail")
  record(bjg = "IB_EOD_SETTLEX", sla = "22:00+04"),
  record(bjg = "IB_FX_RECONX",   sla = "20:00+04")
| lookup [                                    -- ownership metadata table (could be a hosted lookup/CMDB)
    data
      record(bjg="IB_EOD_SETTLEX", team="Settlements", criticality="P1", runbook="https://wiki/eod-settle"),
      record(bjg="IB_FX_RECONX",   team="Treasury",    criticality="P2", runbook="https://wiki/fx-recon")
  ], lookupField: bjg, sourceField: bjg, prefix: "m_"
| fieldsAdd
    team        = coalesce(m_team, "UNOWNED"),
    criticality = coalesce(m_criticality, "P3"),
    runbook     = coalesce(m_runbook, "n/a"),
    summary     = concat(bjg, " missed SLA ", sla, " -> page ", coalesce(m_team, "UNOWNED"))
| fields criticality, bjg, sla, team, runbook, summary
| sort criticality asc
```
→ P1 SETTLE → Settlements, P2 RECON → Treasury, each with runbook + page summary. Unmapped jobs fall
back to `UNOWNED` / `P3`.

**Features used:** `lookup` enrichment · `coalesce` defaults · `concat` (build a message) · `fields`
(column order) · `sort`.

---

*All business cases verified live on tenant `asn8731h.sprint`. Synthetic `data record(...)` stands in
for `fetch logs` / `timeseries`; each case notes the production swap. See `dql-reference.md` for the
feature reference and `dql-filter-after-summarize-bug.md` for the fold gotcha.*

# DQL Gotcha: `filter` Silently Dropped After `summarize`

**Environment:** Dynatrace SaaS / Grail (observed on tenant `asn8731h.sprint`, 2026-06-18)
**Status:** Undocumented optimizer bug. Not in the official DQL docs (reference, best-practices, filtering/aggregation commands all checked). Found by empirical testing. Worth a support ticket.

---

## TL;DR

A `filter` placed **immediately after a `summarize`**, whose predicate the optimizer can reduce to a
compile-time **constant**, is silently mishandled: the constant predicate gets pushed **above** the
`summarize`. If it folds to `false`, it **empties the aggregation's input**, so the query returns a
**phantom row with `count = 0` (and `sum = null`)** instead of an empty result — *and the filter never
actually runs*.

It is **not** about: `toTimestamp()`, `now()` being non-deterministic, the `if`/`else` values, or how
many states you have. It is **only** about whether the filtered expression collapses to a constant.

---

## Symptom

```dql
... | summarize count = count()
| fieldsAdd sla = toTimestamp("18:30+04")
| fieldsAdd sla_status = if(now() > sla AND count < 1, "fail", else: "pass")
| filter sla_status == "fail"
```

Returns a row even though `sla_status` is `"pass"`, with `count = 0`. The filter appears ignored.
Filtering for a value that cannot exist (`filter sla_status == "THIS_DOES_NOT_EXIST"`) *also* returns
the row — the filter is dead.

---

## Root cause / mechanism

1. **Constant fold.** `sla = toTimestamp("18:30+04")` is a known constant, and `now()` is one fixed
   value per query, so `now() > sla` folds to a constant boolean. Before the deadline it is `false`,
   and `false AND count < 1` folds to `false` **without reading `count`** (short-circuit; order in the
   `AND` is irrelevant — `X AND false` folds the same). So `sla_status` becomes the literal `"pass"`.
2. **Predicate becomes field-less.** `filter sla_status == "fail"` → `filter "pass" == "fail"` →
   `filter false`. No column reference remains.
3. **Bad pushdown.** The field-less `filter false` is relocated **above** the `summarize`
   (predicate pushdown — a normal optimization, unsound here).
4. **Input emptied.** `data/logs ... | filter false` → 0 input rows → `count() = 0`, `sum() = null`.
5. **Phantom row.** `summarize` with no `by` **always emits exactly one row**, even over empty input.
   That `{count: 0}` row surfaces, unfiltered, every time — regardless of pass/fail.

### Decisive proof (3-record harness)

```dql
data record(a=1), record(a=2), record(a=3)
| summarize s = sum(a), n = count()
| fieldsAdd label = "no"
| filter label == "yes"
-- expected: 0 rows
-- actual:   1 row { s: null, n: 0 }   <- input was EMPTIED, not merely unfiltered
```

Same query with `filter label == "no"` (folds to `true`) returns `{ s: 6, n: 3 }` intact.
So the bug both **leaks a row** and **corrupts the aggregate values**.

---

## Why it hides

Before the deadline the *genuine* count is also `0`, so the corrupted `0` coincidentally matches
reality and the query "looks right." It only reveals itself when the job **succeeds** (real count ≥ 1):
the phantom still reports `count = 0`, producing a **false breach** while the job was fine.

`true AND count < 1` (i.e. **after** the deadline, when `now() > sla` is `true`) does **not** fold —
it stays `count < 1`, which references the real column. So the same broken query **self-heals after the
deadline** and is silently broken before it.

---

## The rule

> The bug occurs **iff** a `filter`'s predicate folds to a compile-time constant **and** it sits
> immediately after a `summarize` in the same pipeline. Break **either** condition.

---

## Detection (quick diagnostic)

- The returned row's filtered field must **equal** the value you filtered on.
  - **Match** (filter `"fail"` → row shows `"fail"`) = real filtering. ✅
  - **Mismatch** (filter `"fail"` → row shows `"pass"`/`false`) = the fold bug. 🐛
- Cross-check `count` against a plain `summarize count = count()` with no downstream filter.

---

## Solution A — keep the predicate non-foldable

Reference a runtime aggregate column (`count`) at the **top level** so the field can never become a
constant. Put the count check as the **outer** branch:

```dql
fetch logs, from:@d
| filter service == "Batch Job Group"
    AND bjg == "IB_CTOFF_ACTIVATEX"
    AND job_status == "Success"
| summarize count = count()
| fieldsAdd sla = toTimestamp("18:30+04")
| fieldsAdd sla_status = if(count >= 1, "pass",
                       else: if(now() > sla, "fail", else: "pending"))
| filter sla_status == "fail"
```

Simplest variant (no label at all):

```dql
| summarize count = count()
| filter count < 1            -- count from count() is never folded
```

For the "past the deadline" gate, prefer enforcing it by **scheduling when the alert runs** rather than
putting `now() > <ts>` inside the post-`summarize` filter.

**Best for:** single-job checks, simple alerts.

---

## Solution B — isolate the aggregation in a subquery

Move the `summarize` into a `lookup` subquery so the main pipeline's `filter` is after a join, not an
aggregation. The `if` structure then no longer matters, and it scales to many jobs via a driver table.

Single job:

```dql
data ( record(bjg = "IB_CTOFF_ACTIVATEX", sla = "18:30+04") )
| lookup [
    fetch logs, from:@d
    | filter service == "Batch Job Group"
        AND bjg == "IB_CTOFF_ACTIVATEX"
        AND job_status == "Success"
    | summarize cnt = count(), by: {bjg}
  ], lookupField: bjg, prefix: "lk_"
| fieldsAdd count = coalesce(lk_cnt, 0)
| fieldsAdd sla_ts = toTimestamp(sla)
| fieldsAdd sla_status = if(count >= 1, "pass",
                       else: if(now() > sla_ts, "fail", else: "pending"))
| filter sla_status == "fail"
```

Many jobs (one query monitors every SLA):

```dql
data
  record(bjg = "IB_CTOFF_ACTIVATEX", sla = "18:30+04"),
  record(bjg = "IB_SOD_LOADX",       sla = "06:00+04"),
  record(bjg = "IB_EOD_SETTLEX",     sla = "22:00+04")
| lookup [
    fetch logs, from:@d
    | filter service == "Batch Job Group" AND job_status == "Success"
    | summarize cnt = count(), by: {bjg}
  ], lookupField: bjg, prefix: "lk_"
| fieldsAdd count = coalesce(lk_cnt, 0)
| fieldsAdd sla_status = if(count >= 1, "pass",
                       else: if(now() > toTimestamp(sla), "fail", else: "pending"))
| filter sla_status == "fail"
```

**Notes**
- `coalesce(lk_cnt, 0)` replaces the `count + 0` "no rows → 0" trick (no match → null → 0).
- Use a real `prefix:` (e.g. `"lk_"`), **not** `prefix: ""` — empty prefix lets the lookup overwrite
  the driver's `bjg`/`sla` with null on a no-match.

**Best for:** multi-job tables, driving SLA checks off a list.

---

## Validation (both solutions, all states)

| State                        | count | sla_status | `filter == "fail"` |
|------------------------------|:-----:|:----------:|:------------------:|
| Job succeeded                |   3   |   pass     | 0 rows ✅          |
| Missing, before deadline     |   0   |   pending  | 0 rows ✅          |
| Missing, past deadline       |   0   |   fail     | 1 row  ✅          |

---

## Facts worth remembering

- `toTimestamp("18:30+04")` is **valid** — DQL anchors a time-only string to *today* (e.g.
  `2026-06-18T14:30:00Z`). It was never the problem.
- `summarize ... count()` with no `by` **always** emits exactly one row, even over empty input — this
  is what produces the phantom `count = 0`.
- Minimal repro for a bug report:
  ```dql
  data record(a=1), record(a=2), record(a=3)
  | summarize s = sum(a), n = count()
  | fieldsAdd label = "no"
  | filter label == "yes"
  -- expected 0 rows; actual 1 row { s: null, n: 0 }
  ```

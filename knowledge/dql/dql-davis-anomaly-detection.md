# Davis anomaly detection & analyzers — DQL rules

How Davis consumes DQL, and the composition rules that follow. Grounded in the
`builtin:davis.anomaly-detectors` settings schema and the Davis Analyzers v1 API
(both snapshotted in specs/), live-verified on a Gen3 tenant.

## The model: your query owns the SIGNAL, Davis owns TIME

A continuous anomaly detector (`builtin:davis.anomaly-detectors` settings object) is:

```
analyzer:          { name, input[] }   ← your DQL query is one input field
executionSettings: { queryOffset,      ← "minute offset of sliding evaluation window"
                     delay }           ← "fixed delay between executions"
eventTemplate:     { ... }             ← davis event raised on anomaly
```

Davis re-executes the query on a cadence over a **sliding window it computes**
(`queryOffset` shifts that window back for late-arriving data). The ad-hoc Analyzers
API makes the same split structurally: `DimensionQuery` (your DQL) and `Timeframe`
(start/end) are separate inputs.

## Rules for detector/analyzer DQL (all follow from the model)

1. **Output must be timeseries-shaped** — end with `timeseries ...` (metrics) or
   `... | makeTimeseries ...` (records). Analyzers baseline arrays over aligned bins;
   a record table cannot be baselined.
2. **Never pin `from:` / `to:` / `timeframe:`** — a pinned window would be re-evaluated
   frozen on every execution (or conflict with the injected window). Leave the query
   timeframe open; Davis supplies it.
3. **No `limit`** — it would truncate series arbitrarily per evaluation.
4. **Bound `by:` cardinality** — every split series is separately baselined and can
   separately alert.
5. **Choose `default:0` vs null deliberately** — for counts, a null gap reads as
   "no data" while `default:0` reads as a real drop-to-zero; they alert differently.

## Available analyzers (live on tenant, `GET /platform/davis/analyzers/v1/analyzers`)

- `dt.statistics.GenericForecastAnalyzer` (+ `ui.ForecastAnalyzer`) — forecast a series
- `dt.statistics.anomaly_detection.AutoAdaptiveAnomalyDetectionAnalyzer` — self-adjusting baseline
- `dt.statistics.anomaly_detection.SeasonalBaselineAnomalyDetectionAnalyzer` — seasonal patterns
- `dt.statistics.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer` — fixed threshold
- `dt.statistics.clustering.LogPatternExtractor` — cluster log lines into patterns
- `dt.statistics.NoveltyScoreAnalyzer` — novelty scoring
  (each anomaly analyzer also has a `dt.statistics.ui.*` variant used by the app UI)

## MCP flow (deterministic guards built in)

1. `get_davis_analyzer_input_schema(name)` — authoritative input shape (grounding).
2. `validate_davis_analyzer_input(name, input)` — online dry-run `{valid, details}`.
3. `execute_davis_analyzer(name, input)` — auto-validates first, then executes;
   long-running (202) executions are polled automatically.
4. Continuous detectors: `create_settings_object` on `builtin:davis.anomaly-detectors`
   (auto-validateOnly applies as with any settings write).

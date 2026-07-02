# Lookup data in Grail (Resource Store) + DQL `lookup`

Upload reference/enrichment data (e.g. service→owner mappings) into the Grail Resource
Store, then join it in any DQL query with `lookup`.

## Upload flow (MCP tools)

1. `test_lookup_pattern` — verify the parse online first (stores nothing).
2. `upload_lookup_data` — stores the file (auto-runs the same verify first; `dryRun` supported).
3. `delete_resource_file` — remove it.

## DPL parse patterns (live-verified gotchas)

- `parsePattern` is **REQUIRED**. CSV is *not* auto-detected — a blank pattern is rejected with
  `Testing pattern failed: Parse pattern must not be blank.`
- Use `LD:` (line data) for comma-separated columns. For `svc-a,team-red,gold`:

  ```
  LD:id ',' LD:owner ',' LD:tier EOL
  ```

- `STRING:` typically yields **0 records** on comma-separated lines (it is not a
  delimiter-aware CSV matcher) — a silent mismatch, not an error. Use `LD:`.
- Do NOT include a header row in the content when the pattern names the fields —
  the pattern itself defines the field names.
- `lookupField` names the key column; records are deduplicated on it during upload.
- The test-pattern response returns `numberOfRecords`, parsed `records`, and per-field
  `types` mappings — check `numberOfRecords > 0` to confirm the pattern actually matched.

## Using the uploaded data in DQL

```dql
fetch logs
| lookup [ load "/lookups/service-owners" ], sourceField:service.name, lookupField:id
| fields timestamp, content, lookup.owner, lookup.tier
```

- `load "<filePath>"` uses the `filePath` given at upload (e.g. `/lookups/service-owners`).
- Joined fields are prefixed `lookup.` by default (`prefix:` overrides).

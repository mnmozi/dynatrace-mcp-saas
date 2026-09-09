# OpenPipeline — DQL scripting & matchers reference

Two DQL surfaces in OpenPipeline, both a **restricted subset** of query DQL:
1. the **`dql` processor `script`** — transforms records (a pipe of processing commands);
2. the **`matcher`** — a boolean expression on every processor and routing entry deciding
   which records it acts on.

Neither can query/aggregate. If you paste a normal DQL query here it will be rejected.

## `dql` processor — allowed commands (ONLY these)

The processing script is a pipe (`|`) of these commands. **`fetch`, `filter`, `summarize`,
`sort`, `limit`, `join`, `makeTimeseries`, etc. are NOT available** — processing is per-record
transformation, not querying.

| Command | Does | Example |
|---|---|---|
| `parse` | Parse a field with a **DPL** pattern into new fields | `parse content, "LD:ip ' ' LD:method ' ' INT:status"` |
| `fieldsAdd` | Evaluate an expression → add/replace a field | `fieldsAdd size = stringLength(content)` |
| `fields` | Keep only the listed fields (alias of fieldsKeep) | `fields host.name, status` |
| `fieldsKeep` | Keep selected fields | `fieldsKeep timestamp, content` |
| `fieldsRemove` | Remove fields | `fieldsRemove tmp, debug.raw` |
| `fieldsRename` | Rename a field | `fieldsRename msg = content` |
| `fieldsFlatten` | Flatten a nested record/object into top-level fields | `fieldsFlatten payload, prefix: "p."` |

`parse` uses **DPL (Dynatrace Pattern Language)** matchers like `LD` (line data), `INT`,
`IPADDR`, `TIMESTAMP`, `JSON`, `WORD`, `SPACE`/`' '`, etc. — e.g.
`parse content, "TIMESTAMP('yyyy-MM-dd HH:mm:ss'):ts ' ' WORD:level ' ' LD:msg"`.

## `dql` processor — functions (by category)

All standard DQL scalar functions are available in the script. Grouped:

- **String:** `concat`, `contains`, `substring`, `indexOf`, `startsWith`, `endsWith`,
  `upper`, `lower`, `trim`, `splitString`, `replaceString`, `matchesPattern`, `like`,
  `stringLength`, `parse` (inline).
- **Conversion / cast:** `asString`, `asDouble`, `asLong`, `asBoolean`, `asArray`,
  `asTimestamp`, `toString`, `toLong`, `toDouble`, `toBoolean`, `hexStringToNumber`,
  `encodeBase64`, `uid64`, `uid128`, `uuid`.
- **Conditional:** `if`, `coalesce`.
- **Boolean:** `isNull`, `isNotNull`, `isTrueOrNull`, `isFalseOrNull`.
- **Time:** `now`, `timestamp`, `duration`, `formatTimestamp`, `getYear`, `getMonth`,
  `getDay`, `getHour`, Unix-time conversions.
- **Array:** `arraySize`, `arrayFirst`, `arrayLast`, `arraySort`, `arraySum`, `arrayAvg`,
  `arrayMax`, `arrayMin`, `arrayDistinct`, `arrayConcat`, `arrayReverse`, `arrayMedian`,
  `arrayPercentile`.
- **Network / IP:** `ip`, `ipIn`, `ipIsPrivate`, `ipIsPublic`, `ipIsLoopback`, `isIpV4`, `isIpV6`.
- **Cryptographic:** `hashMd5`, `hashSha1`, `hashSha256`, `hashSha512`, `hashCrc32`,
  `hashXxHash32`, `hashXxHash64`.
- **Bitwise:** `bitwiseAnd`, `bitwiseOr`, `bitwiseXor`, `bitwiseNot`, `bitwiseShiftLeft`,
  `bitwiseShiftRight`, `bitwiseCountOnes`.
- **Math:** `abs`, `sqrt`, `power`, `round`, `floor`, `ceil`, `sin`, `cos`, `tan`, `log`,
  `log10`, `pi`, `e`.
- **General:** `exists`, `in`, `record`.

Example multi-step script:
```
parse content, "IPADDR:client.ip ' ' LD:method ' ' INT:status"
| fieldsAdd status.class = concat(substring(toString(status),0,1), "xx")
| fieldsAdd is_error = if(status >= 500, true, else: false)
| fieldsRemove content
```

## `matcher` — the boolean selector (processors + routing entries)

Runs on each record; `true` → the processor/route applies. Reduces scope for what follows.

**Core functions:**
- `matchesPhrase(field, "text")` — case-insensitive phrase match with word boundaries;
  wildcard `*` allowed only at start or end. `matchesPhrase(content, "error")`
- `matchesValue(field, "val")` — case-insensitive value match; handles multi-value fields.
  `matchesValue(process.technology, "nginx")`
- `isNull(field)` / `isNotNull(field)` — presence tests.

**Operators:** `and`, `or`, `not`; numeric/comparison `<`, `>`, `<=`, `>=`, `==`, `!=`.

**Match-all / match-none:** literal `true` (all records) / `false` (skip entirely).

Examples:
```
true                                                   # every record
matchesPhrase(content, "error")                        # error logs
matchesValue(event.provider, "orders.web")             # routing: web orders
matchesPhrase(content, "error") and http.request.body.size > 1024
not matchesValue(status, "success")
isNotNull(client.ip) and environment == "production"
```

## The two-language rule (most common mistake)
- **matcher** = *which records* → `matchesPhrase` / `matchesValue` / comparisons, boolean.
- **dql script** = *transform the record* → `parse` / `fieldsAdd` / … + scalar functions.
Don't put `parse`/`fieldsAdd` in a matcher, and don't put `matchesPhrase` in a script.
Both validate online — a wrong command/function comes back as a `constraintViolation` from
`create/update_settings_object` (dryRun) before anything is written.

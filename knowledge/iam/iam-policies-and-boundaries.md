# IAM policies, boundaries & bindings — input reference

Grounding for the account IAM tools (create_policy, create_policy_boundary,
bind_policy_to_groups). Grammar from Dynatrace docs; examples live-verified on a
Gen3 account. The IAM triad:

- **policy**   — WHAT is allowed (permission statements → `statementQuery`)
- **boundary** — WHERE it applies (conditions → `boundaryQuery`)
- **binding**  — the ASSIGNMENT: policy → group(s), optionally limited by boundaries.
  A policy/boundary does NOTHING until a binding ties it to a group.

Everything lives at a **level**: `account` / `environment` / `global`.

## Policy statement syntax (`statementQuery`)

```
ALLOW <permissions> [WHERE <conditions>];
DENY  <permissions> [WHERE <conditions>];
```

- **Permission** = `service:resource:action`, e.g. `storage:logs:read`,
  `settings:objects:write`, `automation:workflows:run`. Multiple comma-separated.
- **Conditions** (optional): `WHERE <service:attribute> <op> "value"`.
  Operators: `=`, `!=`, `<`, `>`, `IN`, `NOT IN`, `startsWith`, `NOT startsWith`, `MATCH`.
- **Combine** conditions with `AND` only (**OR is NOT supported**).
- **DENY overrides ALLOW.** Evaluation order: unconditional DENY → conditional DENY →
  unconditional ALLOW → conditional ALLOW → reject.
- Every statement ends with `;`.

Examples:
```
ALLOW settings:schemas:read;
ALLOW storage:logs:read WHERE storage:k8s.namespace.name = "apps";
ALLOW settings:objects:read, settings:objects:write WHERE settings:schemaId = "builtin:tags.auto-tagging";
ALLOW storage:events:read WHERE storage:event.type IN ("order.attempt", "payment.attempt");
```
Live tenant example: `ALLOW storage:events:write;`

### Permission vocabulary (service:resource:action — representative, not exhaustive)

Mirrors the OAuth scope catalog. Common families:
- **storage** (Grail): `storage:logs:read/write`, `storage:events:read/write`,
  `storage:metrics:read`, `storage:bizevents:read`, `storage:spans:read`,
  `storage:entities:read`, `storage:buckets:read`, `storage:system:read`,
  `storage:filter-segments:read/write`
- **settings**: `settings:objects:read/write`, `settings:schemas:read`, `settings:objects:admin`
- **document**: `document:documents:read/write/delete`, `document:direct-shares:read/write`
- **automation**: `automation:workflows:read/write/run`, `automation:rules:read/write`
- **openpipeline**: `openpipeline:configurations:read/write`
- **davis**: `davis:analyzers:read/execute`
- **slo**: `slo:slos:read/write`
- **hub / email / notification / app-engine / …** likewise
Authoritative full list: Dynatrace docs "IAM policy statement syntax" + the permission
picker in the OAuth-client / policy editor UI.

## Boundary syntax (`boundaryQuery`)

Restricts WHERE a bound policy applies. Simpler grammar than statements:

```
<field> <operator> <value>;      ← ONE condition per line
```

- **Operators**: `=`, `IN`, `startsWith` (that's it — no `AND`, no logical operators).
- **Multiple lines = additive** (each newline-separated condition applies).
- **Max 10 conditions** per boundary.
- Each condition ends with `;`.
- When several boundaries apply to a binding, effective statements are computed
  **per boundary** separately.

Fields:
- **`storage:<grail-field>`** — record-level (Grail) scoping, e.g.
  `storage:k8s.namespace.name`, `storage:host.name`, `storage:dt.security_context`,
  `storage:event.type`. Any Grail field works — discover valid names via
  `fetch dt.semantic_dictionary.fields` (see dql_reference topic "fields").
- **`environment:management-zone`** — classic management-zone scoping.

Examples:
```
storage:k8s.namespace.name = "apps";
storage:k8s.namespace.name IN ("dev", "preprod");
environment:management-zone startsWith "[Kubernetes]";
```
Live tenant example (boundary `boundary-team-orders`):
```
storage:k8s.namespace.name = "apps";
storage:event.type = "order.attempt";
```

## The create → assign loop (what makes it live)

```
create_account_group(name)                                → groupUuid   (account-idm-write)
create_policy(name, statementQuery)                       → policyUuid
create_policy_boundary(name, boundaryQuery)               → boundaryUuid
set_group_policies(groupUuid, [policyUuid])               ← now effective (documented path)
```
Boundaries and policies are inert on their own; the **binding** is the switch.

### Binding endpoints (two variants — mind the METHOD)
| Intent | Method + path | Body |
|---|---|---|
| Set a **group's** policies (recommended) | `PUT /bindings/groups/{groupUuid}` | `{ policyUuids: [...] }` → 204 |
| Update a **policy's** bindings | `POST /bindings/{policyUuid}` | `{ groups: [...], boundaries: [...] }` |
| Remove one policy↔group binding | `DELETE /bindings/{policyUuid}/{groupUuid}` | — |

- `PUT /bindings/{policyUuid}` does **NOT** exist → 404 (live-verified). Use POST there.
- `set_group_policies` **replaces** the group's whole set: any policy not in the request is
  discarded. Pass the full desired list.
- Attaching boundaries goes through the policy-centric POST variant.

## Gotchas
- Policy conditions allow `AND`; boundaries do NOT (one condition per line only).
- OR is unsupported everywhere — model alternatives with `IN (...)`.
- `storage:` prefix ties conditions to Grail fields; spell them exactly (semantic dictionary).
- DENY beats ALLOW — use sparingly and deliberately.

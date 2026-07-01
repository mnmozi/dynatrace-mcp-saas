# Dynatrace SaaS MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript MCP server for Dynatrace SaaS (Gen3 Platform) that exposes both configuration/management tools (dashboards, settings, SLOs, synthetic) and observability tools (DQL, logs, traces, metrics, entities, problems, vulnerabilities), grounded in OpenAPI specs downloaded from the live tenant.

**Architecture:** A single `DynatraceClient` is the only component that performs HTTP, routing each call to one of two hosts with the correct token type (classic `Api-Token` vs platform `Bearer`). Tools are thin, Zod-validated modules grouped by domain; writes are blocked unless `DT_ENABLE_WRITES=true`. DQL is async (execute→poll). stdio transport.

**Tech Stack:** Node 20+, TypeScript (NodeNext, strict), `@modelcontextprotocol/sdk`, `zod`, `vitest` + `msw` for tests. Global `fetch` (no axios).

---

## Reference: spec & grounding artifacts

- Design spec: `docs/specs/2026-06-02-dynatrace-saas-mcp-design.md`
- OpenAPI specs (read these when shaping a tool): `specs/platform/*.yaml`, `specs/classic/environment-api-v{1,2}.json`
- Verified env facts: two hosts (`DT_PLATFORM_URL` Bearer, `DT_CLASSIC_URL` Api-Token); DQL async via `query:execute`→`query:poll`; dashboards are documents at `/platform/document/v1`.

## Shared contracts (defined once, referenced everywhere)

**Config** (Task 2):

```ts
export interface Config {
  platformUrl: string; // no trailing slash
  classicUrl: string; // no trailing slash
  platformToken: string;
  apiToken: string;
  enableWrites: boolean;
  timeoutMs: number;
}
```

**HostClient & DynatraceClient** (Task 4):

```ts
export interface HostClient {
  get<T = unknown>(path: string, query?: QueryParams): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T>;
  del<T = unknown>(path: string, query?: QueryParams): Promise<T>;
}
export type QueryParams = Record<string, string | number | boolean | undefined>;

export class DynatraceClient {
  readonly classic: HostClient; // DT_CLASSIC_URL + "Api-Token <apiToken>"
  readonly platform: HostClient; // DT_PLATFORM_URL + "Bearer <platformToken>"
  dqlExecute(query: string, opts?: { maxResultRecords?: number; timeoutMs?: number }): Promise<DqlResult>;
}
```

**DQL result** (Task 5):

```ts
export interface DqlResult {
  records: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}
```

**Tool module contract** (every `src/tools/*.ts`):

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export interface ToolDeps {
  client: DynatraceClient;
  config: Config;
}
export function registerXxx(server: McpServer, deps: ToolDeps): void;
```

**Tool result helper** (Task 7, `src/util/result.ts`):

```ts
export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
```

---

# Phase A — Foundation

### Task 1: Project scaffold

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts` (placeholder)
- Create: `test/setup.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "dynatrace-saas-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "dynatrace-saas-mcp": "dist/index.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "dotenv": "^16.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "msw": "^2.4.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `test/setup.ts` (empty for now)**

```ts
// Global test setup. msw servers are created per-test-file.
export {};
```

- [ ] **Step 5: Create placeholder `src/index.ts`**

```ts
// Entry point — implemented in Task 7.
export {};
```

- [ ] **Step 6: Install deps and verify typecheck**

Run: `cd /Users/nasr/mycode/personal/saas-mcp && npm install && npm run typecheck`
Expected: install succeeds; `tsc --noEmit` exits 0 with no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/index.ts test/setup.ts
git commit -m "chore: scaffold TypeScript MCP project"
```

---

### Task 2: Config loader

**Files:**

- Create: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DT_PLATFORM_URL: "https://x.apps.dynatracelabs.com/",
  DT_CLASSIC_URL: "https://x.dynatracelabs.com",
  DT_PLATFORM_TOKEN: "dt0s16.AAA",
  DT_API_TOKEN: "dt0c01.BBB",
};

describe("loadConfig", () => {
  it("parses env, strips trailing slash, defaults writes off", () => {
    const c = loadConfig(base);
    expect(c.platformUrl).toBe("https://x.apps.dynatracelabs.com");
    expect(c.classicUrl).toBe("https://x.dynatracelabs.com");
    expect(c.enableWrites).toBe(false);
    expect(c.timeoutMs).toBe(30000);
  });

  it("enables writes only when exactly 'true'", () => {
    expect(loadConfig({ ...base, DT_ENABLE_WRITES: "true" }).enableWrites).toBe(true);
    expect(loadConfig({ ...base, DT_ENABLE_WRITES: "1" }).enableWrites).toBe(false);
  });

  it("throws a clear error when a required var is missing", () => {
    const { DT_API_TOKEN, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DT_API_TOKEN/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- config`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Config } from "./types.js";

export type { Config } from "./types.js";

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const v = env[key];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v.trim();
}

const stripSlash = (u: string) => u.replace(/\/+$/, "");

export function loadConfig(env: Env = process.env): Config {
  return {
    platformUrl: stripSlash(required(env, "DT_PLATFORM_URL")),
    classicUrl: stripSlash(required(env, "DT_CLASSIC_URL")),
    platformToken: required(env, "DT_PLATFORM_TOKEN"),
    apiToken: required(env, "DT_API_TOKEN"),
    enableWrites: env.DT_ENABLE_WRITES === "true",
    timeoutMs: env.DT_HTTP_TIMEOUT_MS ? Number(env.DT_HTTP_TIMEOUT_MS) : 30000,
  };
}
```

- [ ] **Step 4: Create `src/types.ts`**

```ts
export interface Config {
  platformUrl: string;
  classicUrl: string;
  platformToken: string;
  apiToken: string;
  enableWrites: boolean;
  timeoutMs: number;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- config`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/types.ts test/config.test.ts
git commit -m "feat: config loader with dual-host/dual-token + write gate"
```

---

### Task 3: Error normalization

**Files:**

- Create: `src/http/errors.ts`
- Test: `test/errors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { DynatraceApiError, friendlyMessage } from "../src/http/errors.js";

describe("friendlyMessage", () => {
  it("explains 401 with token-type hint", () => {
    expect(friendlyMessage(401, "platform")).toMatch(/Bearer.*platform token/i);
    expect(friendlyMessage(401, "classic")).toMatch(/Api-Token/i);
  });
  it("explains 403 as missing scope", () => {
    expect(friendlyMessage(403, "classic")).toMatch(/scope/i);
  });
  it("explains 404 as not found / unavailable", () => {
    expect(friendlyMessage(404, "platform")).toMatch(/not found|unavailable/i);
  });
});

describe("DynatraceApiError", () => {
  it("carries status, host, and body", () => {
    const e = new DynatraceApiError(429, "platform", { error: "rate" }, "/x");
    expect(e.status).toBe(429);
    expect(e.host).toBe("platform");
    expect(e.message).toMatch(/429/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- errors`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
export type HostKind = "classic" | "platform";

export function friendlyMessage(status: number, host: HostKind): string {
  switch (status) {
    case 401:
      return host === "platform"
        ? "401 Unauthorized: platform APIs need a Bearer platform token (dt0s16). Check DT_PLATFORM_TOKEN."
        : "401 Unauthorized: classic APIs need an Api-Token (dt0c01). Check DT_API_TOKEN.";
    case 403:
      return `403 Forbidden: the ${host} token is missing a required scope for this endpoint.`;
    case 404:
      return "404: resource not found, or this endpoint is unavailable on this tenant.";
    case 429:
      return "429 Too Many Requests: rate limited; retry after the indicated delay.";
    default:
      return status >= 500 ? `${status}: Dynatrace server error; retry later.` : `${status}: request failed.`;
  }
}

export class DynatraceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly host: HostKind,
    public readonly body: unknown,
    public readonly path: string,
  ) {
    super(`${friendlyMessage(status, host)} (${host} ${path})`);
    this.name = "DynatraceApiError";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- errors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http/errors.ts test/errors.test.ts
git commit -m "feat: HTTP error normalization with token-type hints"
```

---

### Task 4: DynatraceClient (dual host/auth)

**Files:**

- Create: `src/http/client.ts`
- Test: `test/client.test.ts`

- [ ] **Step 1: Write the failing test (msw-mocked)**

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { DynatraceClient } from "../src/http/client.js";
import { DynatraceApiError } from "../src/http/errors.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "PTOK",
  apiToken: "ATOK",
  enableWrites: false,
  timeoutMs: 5000,
};

const server = setupServer(
  http.get("https://classic.example.com/api/v2/ping", ({ request }) => {
    return HttpResponse.json({ auth: request.headers.get("authorization") });
  }),
  http.get("https://plat.example.com/platform/ping", ({ request }) => {
    return HttpResponse.json({ auth: request.headers.get("authorization") });
  }),
  http.get("https://classic.example.com/api/v2/boom", () =>
    HttpResponse.json({ error: { message: "no" } }, { status: 403 }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("DynatraceClient", () => {
  const c = new DynatraceClient(cfg);

  it("uses Api-Token on classic host", async () => {
    const r = await c.classic.get<{ auth: string }>("/api/v2/ping");
    expect(r.auth).toBe("Api-Token ATOK");
  });

  it("uses Bearer on platform host", async () => {
    const r = await c.platform.get<{ auth: string }>("/platform/ping");
    expect(r.auth).toBe("Bearer PTOK");
  });

  it("throws DynatraceApiError on non-2xx", async () => {
    await expect(c.classic.get("/api/v2/boom")).rejects.toBeInstanceOf(DynatraceApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- client`
Expected: FAIL — cannot find module `../src/http/client.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Config } from "../types.js";
import { DynatraceApiError, type HostKind, type QueryParams } from "./errors.js";
import type { HostClient } from "../types.js";

function buildUrl(base: string, path: string, query?: QueryParams): string {
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

class HostClientImpl implements HostClient {
  constructor(
    private readonly base: string,
    private readonly authHeader: string,
    private readonly host: HostKind,
    private readonly timeoutMs: number,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, query?: QueryParams): Promise<T> {
    const url = buildUrl(this.base, path, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? safeJson(text) : undefined;
      if (!res.ok) {
        throw new DynatraceApiError(res.status, this.host, parsed ?? text, path);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string, query?: QueryParams) {
    return this.request<T>("GET", path, undefined, query);
  }
  post<T>(path: string, body?: unknown, query?: QueryParams) {
    return this.request<T>("POST", path, body, query);
  }
  put<T>(path: string, body?: unknown, query?: QueryParams) {
    return this.request<T>("PUT", path, body, query);
  }
  del<T>(path: string, query?: QueryParams) {
    return this.request<T>("DELETE", path, undefined, query);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class DynatraceClient {
  readonly classic: HostClient;
  readonly platform: HostClient;

  constructor(private readonly cfg: Config) {
    this.classic = new HostClientImpl(cfg.classicUrl, `Api-Token ${cfg.apiToken}`, "classic", cfg.timeoutMs);
    this.platform = new HostClientImpl(cfg.platformUrl, `Bearer ${cfg.platformToken}`, "platform", cfg.timeoutMs);
  }
}
```

- [ ] **Step 4: Add shared types to `src/types.ts`**

```ts
// append to src/types.ts
export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface HostClient {
  get<T = unknown>(path: string, query?: QueryParams): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T>;
  del<T = unknown>(path: string, query?: QueryParams): Promise<T>;
}
```

Also update `src/http/errors.ts` to re-export `QueryParams` for the import in `client.ts`:

```ts
// append to src/http/errors.ts
export type { QueryParams } from "../types.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- client`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/http/client.ts src/types.ts src/http/errors.ts test/client.test.ts
git commit -m "feat: DynatraceClient with dual host/auth routing"
```

---

### Task 5: DQL execute→poll helper

**Files:**

- Modify: `src/http/client.ts` (add `dqlExecute`)
- Create: `src/http/dql.ts` (poll logic)
- Test: `test/dql.test.ts`

- [ ] **Step 1: Write the failing test (msw-mocked async flow)**

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { DynatraceClient } from "../src/http/client.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "PTOK",
  apiToken: "ATOK",
  enableWrites: false,
  timeoutMs: 5000,
};

let polls = 0;
const server = setupServer(
  http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
    HttpResponse.json({ state: "RUNNING", requestToken: "RT1", ttlSeconds: 100 }, { status: 202 }),
  ),
  http.get("https://plat.example.com/platform/storage/query/v1/query:poll", () => {
    polls += 1;
    if (polls < 2) return HttpResponse.json({ state: "RUNNING" }, { status: 202 });
    return HttpResponse.json({ state: "SUCCEEDED", result: { records: [{ host: "h1" }] } });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  polls = 0;
});
afterAll(() => server.close());

describe("dqlExecute", () => {
  it("executes then polls until SUCCEEDED and returns records", async () => {
    const c = new DynatraceClient(cfg);
    const r = await c.dqlExecute("fetch dt.entity.host | limit 1", { pollIntervalMs: 1 });
    expect(r.records).toEqual([{ host: "h1" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dql`
Expected: FAIL — `c.dqlExecute is not a function`.

- [ ] **Step 3: Create `src/http/dql.ts`**

```ts
import type { HostClient } from "../types.js";

export interface DqlResult {
  records: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

interface ExecuteResponse {
  state: string;
  requestToken?: string;
  result?: RawResult;
}
interface PollResponse {
  state: string;
  result?: RawResult;
  progress?: number;
}
interface RawResult {
  records?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

const BASE = "/platform/storage/query/v1";

export async function dqlExecute(
  platform: HostClient,
  query: string,
  opts: { maxResultRecords?: number; pollIntervalMs?: number; maxPolls?: number } = {},
): Promise<DqlResult> {
  const { maxResultRecords = 1000, pollIntervalMs = 500, maxPolls = 120 } = opts;
  const start = await platform.post<ExecuteResponse>(`${BASE}/query:execute`, {
    query,
    maxResultRecords,
    requestTimeoutMilliseconds: 60000,
    fetchTimeoutSeconds: 60,
  });

  if (start.state === "SUCCEEDED" && start.result) return normalize(start.result);
  const token = start.requestToken;
  if (!token) throw new Error("DQL execute returned no requestToken and was not SUCCEEDED");

  for (let i = 0; i < maxPolls; i++) {
    const poll = await platform.get<PollResponse>(`${BASE}/query:poll`, { "request-token": token });
    if (poll.state === "SUCCEEDED") return normalize(poll.result);
    if (poll.state === "FAILED" || poll.state === "CANCELLED") {
      throw new Error(`DQL query ${poll.state}: ${JSON.stringify(poll)}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`DQL query did not complete after ${maxPolls} polls`);
}

function normalize(result?: RawResult): DqlResult {
  return { records: result?.records ?? [], metadata: result?.metadata };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

- [ ] **Step 4: Wire `dqlExecute` into `DynatraceClient` in `src/http/client.ts`**

Add import at top:

```ts
import { dqlExecute, type DqlResult } from "./dql.js";
```

Add method to the `DynatraceClient` class body:

```ts
  dqlExecute(query: string, opts?: { maxResultRecords?: number; pollIntervalMs?: number; maxPolls?: number }): Promise<DqlResult> {
    return dqlExecute(this.platform, query, opts);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- dql`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http/dql.ts src/http/client.ts test/dql.test.ts
git commit -m "feat: async DQL execute->poll helper"
```

> **Implementation note:** the exact `query:poll` parameter name (`request-token`) and execute body fields must be confirmed against `specs/platform/platform_storage_query_v1.yaml` during this task. Adjust the param/body to match the spec before finishing.

---

### Task 6: Write guard

**Files:**

- Create: `src/util/guards.ts`
- Test: `test/guards.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { requireWrites } from "../src/util/guards.js";
import type { Config } from "../src/types.js";

const cfg = (enableWrites: boolean): Config => ({
  platformUrl: "x",
  classicUrl: "x",
  platformToken: "x",
  apiToken: "x",
  enableWrites,
  timeoutMs: 1,
});

describe("requireWrites", () => {
  it("throws when writes disabled", () => {
    expect(() => requireWrites(cfg(false))).toThrow(/DT_ENABLE_WRITES=true/);
  });
  it("does nothing when writes enabled", () => {
    expect(() => requireWrites(cfg(true))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- guards`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { Config } from "../types.js";

export function requireWrites(config: Config): void {
  if (!config.enableWrites) {
    throw new Error("Write blocked: set DT_ENABLE_WRITES=true to enable mutating operations (create/update/delete).");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- guards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/guards.ts test/guards.test.ts
git commit -m "feat: requireWrites guard"
```

---

### Task 7: Server bootstrap, registry, result helper

**Files:**

- Create: `src/util/result.ts`
- Create: `src/tools/registry.ts`
- Modify: `src/index.ts`
- Test: `test/registry.test.ts`

- [ ] **Step 1: Create `src/util/result.ts`**

```ts
export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
```

- [ ] **Step 2: Write the failing registry test**

```ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "../src/tools/registry.js";
import { DynatraceClient } from "../src/http/client.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  platformUrl: "https://p",
  classicUrl: "https://c",
  platformToken: "p",
  apiToken: "a",
  enableWrites: false,
  timeoutMs: 1000,
};

describe("registerAllTools", () => {
  it("registers tools without throwing", () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    const client = new DynatraceClient(cfg);
    expect(() => registerAllTools(server, { client, config: cfg })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- registry`
Expected: FAIL — cannot find module `registry.js`.

- [ ] **Step 4: Write `src/tools/registry.ts` (imports added as each tool task lands)**

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DynatraceClient } from "../http/client.js";
import type { Config } from "../types.js";

export interface ToolDeps {
  client: DynatraceClient;
  config: Config;
}

// Tool registrations are added here by Tasks 8–19.
export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  void server;
  void deps;
}
```

- [ ] **Step 5: Write `src/index.ts` (stdio entry)**

```ts
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { DynatraceClient } from "./http/client.js";
import { registerAllTools } from "./tools/registry.js";

async function main() {
  const config = loadConfig();
  const client = new DynatraceClient(config);
  const server = new McpServer({ name: "dynatrace-saas-mcp", version: "0.1.0" });
  registerAllTools(server, { client, config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`dynatrace-saas-mcp ready (writes ${config.enableWrites ? "ENABLED" : "disabled"})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Run test + typecheck**

Run: `npm test -- registry && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/util/result.ts src/tools/registry.ts src/index.ts test/registry.test.ts
git commit -m "feat: server bootstrap, tool registry, result helpers"
```

---

# Phase B — Observability tools

> **Pattern for every tool task below:** (1) write an msw-mocked test asserting the handler returns expected JSON; (2) run it red; (3) implement the module `register*` fn using `server.tool(name, description, zodShape, handler)` and `jsonResult(...)`; (4) add the `register*` call to `registry.ts`; (5) run green; (6) commit. Write tools call `requireWrites(deps.config)` first. Always read the matching spec in `specs/` to confirm paths/params before implementing.

### Task 8: DQL tools (`execute_dql`, `verify_dql`)

**Files:**

- Create: `src/tools/dql.ts`
- Modify: `src/tools/registry.ts`
- Test: `test/tools/dql.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDqlTools } from "../../src/tools/dql.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://c",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

const server = setupServer(
  http.post("https://plat.example.com/platform/storage/query/v1/query:execute", () =>
    HttpResponse.json({ state: "SUCCEEDED", result: { records: [{ n: 1 }] } }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerDqlTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("execute_dql tool", () => {
  it("returns records as JSON text", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "execute_dql", arguments: { query: "fetch logs | limit 1" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('"n": 1');
  });
});
```

- [ ] **Step 2: Run test red**

Run: `npm test -- tools/dql`
Expected: FAIL — cannot find module `dql.js`.

- [ ] **Step 3: Implement `src/tools/dql.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

export function registerDqlTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "execute_dql",
    "Execute a Dynatrace Query Language (DQL) statement against Grail and return the result records. Use for logs, spans/traces, events, metrics, and entities. Example: 'fetch logs | filter loglevel == \"ERROR\" | limit 50'.",
    {
      query: z.string().describe("The DQL statement to execute."),
      maxResultRecords: z
        .number()
        .int()
        .positive()
        .max(10000)
        .optional()
        .describe("Max records to return (default 1000)."),
    },
    async ({ query, maxResultRecords }) => {
      const result = await deps.client.dqlExecute(query, { maxResultRecords });
      return jsonResult({ recordCount: result.records.length, records: result.records });
    },
  );

  server.tool(
    "verify_dql",
    "Validate a DQL statement without returning data (executes with limit 0). Returns ok=true or the validation error.",
    { query: z.string().describe("The DQL statement to validate.") },
    async ({ query }) => {
      try {
        await deps.client.dqlExecute(`${query} | limit 0`, { maxResultRecords: 1 });
        return jsonResult({ ok: true });
      } catch (e) {
        return jsonResult({ ok: false, error: (e as Error).message });
      }
    },
  );
}
```

- [ ] **Step 4: Register in `src/tools/registry.ts`**

Add import: `import { registerDqlTools } from "./dql.js";`
Add inside `registerAllTools`: `registerDqlTools(server, deps);`
Remove the `void server; void deps;` line once at least one register call is present.

- [ ] **Step 5: Run test green**

Run: `npm test -- tools/dql`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/dql.ts src/tools/registry.ts test/tools/dql.test.ts
git commit -m "feat: execute_dql and verify_dql tools"
```

---

### Task 9: Metrics tools (`list_metrics`, `get_metric_metadata`, `query_metric`)

**Files:**

- Create: `src/tools/metrics.ts`
- Modify: `src/tools/registry.ts`
- Test: `test/tools/metrics.test.ts`

Endpoints (classic, confirm in `specs/classic/environment-api-v2.json`):
`GET /api/v2/metrics`, `GET /api/v2/metrics/{metricKey}`, `GET /api/v2/metrics/query?metricSelector=&from=&to=&resolution=`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMetricsTools } from "../../src/tools/metrics.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://p",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};
const server = setupServer(
  http.get("https://classic.example.com/api/v2/metrics", () =>
    HttpResponse.json({ metrics: [{ metricId: "builtin:host.cpu.usage" }], totalCount: 1 }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerMetricsTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_metrics", () => {
  it("returns metric descriptors", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_metrics", arguments: { selector: "builtin:host.*" } });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("builtin:host.cpu.usage");
  });
});
```

- [ ] **Step 2: Run test red** — Run: `npm test -- tools/metrics`; Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/tools/metrics.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

export function registerMetricsTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "list_metrics",
    "List/search metric descriptors (classic Metrics v2). Use a metricSelector like 'builtin:host.*' to filter.",
    {
      selector: z.string().optional().describe("metricSelector filter, e.g. 'builtin:host.cpu.*'."),
      pageSize: z.number().int().positive().max(500).optional().describe("Page size (default 100)."),
    },
    async ({ selector, pageSize }) =>
      jsonResult(
        await deps.client.classic.get("/api/v2/metrics", {
          metricSelector: selector,
          pageSize: pageSize ?? 100,
          fields: "metricId,displayName,unit,description,defaultAggregation",
        }),
      ),
  );

  server.tool(
    "get_metric_metadata",
    "Get the descriptor/metadata for a single metric by key (classic Metrics v2).",
    { metricKey: z.string().describe("The metric key, e.g. 'builtin:host.cpu.usage'.") },
    async ({ metricKey }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/metrics/${encodeURIComponent(metricKey)}`)),
  );

  server.tool(
    "query_metric",
    "Query metric data points (classic Metrics v2). Returns timeseries for the given selector and timeframe.",
    {
      metricSelector: z.string().describe("metricSelector, e.g. 'builtin:host.cpu.usage:avg'."),
      from: z.string().optional().describe("Start time, e.g. 'now-2h' or ISO-8601."),
      to: z.string().optional().describe("End time, e.g. 'now'."),
      resolution: z.string().optional().describe("Resolution, e.g. '1m', '1h'."),
      entitySelector: z.string().optional().describe("Optional entitySelector to scope results."),
    },
    async ({ metricSelector, from, to, resolution, entitySelector }) =>
      jsonResult(
        await deps.client.classic.get("/api/v2/metrics/query", {
          metricSelector,
          from,
          to,
          resolution,
          entitySelector,
        }),
      ),
  );
}
```

- [ ] **Step 4: Register** — add `import { registerMetricsTools } from "./metrics.js";` and `registerMetricsTools(server, deps);` to `registry.ts`.

- [ ] **Step 5: Run test green** — Run: `npm test -- tools/metrics`; Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/metrics.ts src/tools/registry.ts test/tools/metrics.test.ts
git commit -m "feat: metrics tools (list/get/query)"
```

---

### Task 10: Entities & hosts tools

**Files:** Create `src/tools/entities.ts`; Modify `registry.ts`; Test `test/tools/entities.test.ts`.

Endpoints (classic v2): `GET /api/v2/entities?entitySelector=&fields=`, `GET /api/v2/entities/{id}`, `GET /api/v2/entityTypes`.

- [ ] **Step 1: Failing test** (mock `GET /api/v2/entities` returning `{ entities: [{ entityId: "HOST-1", displayName: "web01" }] }`; assert `list_hosts` output contains `web01`). Use the same `makeClient` harness as Task 9, swapping in `registerEntitiesTools`.

```ts
http.get("https://classic.example.com/api/v2/entities", () =>
  HttpResponse.json({ entities: [{ entityId: "HOST-1", displayName: "web01" }], totalCount: 1 }),
);
```

- [ ] **Step 2: Run red** — `npm test -- tools/entities`; Expected: FAIL.

- [ ] **Step 3: Implement `src/tools/entities.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

export function registerEntitiesTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "list_hosts",
    "List monitored hosts (classic Entities v2, entitySelector type(HOST)). Optional tag/management-zone filters.",
    {
      tag: z.string().optional().describe("Filter by tag, e.g. 'env:prod'."),
      managementZone: z.string().optional().describe("Filter by management zone name."),
      pageSize: z.number().int().positive().max(500).optional(),
    },
    async ({ tag, managementZone, pageSize }) => {
      let selector = "type(HOST)";
      if (tag) selector += `,tag("${tag}")`;
      if (managementZone) selector += `,mzName("${managementZone}")`;
      return jsonResult(
        await deps.client.classic.get("/api/v2/entities", {
          entitySelector: selector,
          pageSize: pageSize ?? 100,
          fields: "+properties.osType,+properties.monitoringMode,+tags",
        }),
      );
    },
  );

  server.tool(
    "find_entities",
    "Find monitored entities by entitySelector (services, process groups, applications, etc.).",
    {
      entitySelector: z.string().describe('entitySelector, e.g. type(SERVICE),entityName.contains("checkout").'),
      from: z.string().optional(),
      to: z.string().optional(),
      pageSize: z.number().int().positive().max(500).optional(),
    },
    async ({ entitySelector, from, to, pageSize }) =>
      jsonResult(
        await deps.client.classic.get("/api/v2/entities", {
          entitySelector,
          from,
          to,
          pageSize: pageSize ?? 100,
          fields: "+tags,+properties",
        }),
      ),
  );

  server.tool(
    "get_entity",
    "Get details for one monitored entity by id, including properties and relationships.",
    { entityId: z.string().describe("Entity id, e.g. 'HOST-ABC123' or 'SERVICE-XYZ'.") },
    async ({ entityId }) =>
      jsonResult(
        await deps.client.classic.get(`/api/v2/entities/${encodeURIComponent(entityId)}`, {
          fields: "+properties,+toRelationships,+fromRelationships,+tags",
        }),
      ),
  );

  server.tool(
    "list_entity_types",
    "List available entity types (classic Entities v2).",
    { pageSize: z.number().int().positive().max(500).optional() },
    async ({ pageSize }) =>
      jsonResult(await deps.client.classic.get("/api/v2/entityTypes", { pageSize: pageSize ?? 200 })),
  );
}
```

- [ ] **Step 4: Register** in `registry.ts`.
- [ ] **Step 5: Run green** — `npm test -- tools/entities`; Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat: entities & hosts tools"`.

---

### Task 11: Problems tools

**Files:** Create `src/tools/problems.ts`; Modify `registry.ts`; Test `test/tools/problems.test.ts`.

Endpoints (classic v2): `GET /api/v2/problems?problemSelector=&from=&to=`, `GET /api/v2/problems/{problemId}`.

- [ ] **Step 1: Failing test** (mock `GET /api/v2/problems` → `{ problems: [{ problemId: "P-1", title: "High CPU" }] }`; assert `list_problems` contains `High CPU`).
- [ ] **Step 2: Run red** — `npm test -- tools/problems`.
- [ ] **Step 3: Implement `src/tools/problems.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

export function registerProblemsTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "list_problems",
    "List problems (classic Problems v2). Filter by status/severity via problemSelector and a timeframe.",
    {
      problemSelector: z.string().optional().describe('e.g. status("OPEN"),severityLevel("AVAILABILITY").'),
      from: z.string().optional().describe("default 'now-2h'."),
      to: z.string().optional(),
      pageSize: z.number().int().positive().max(500).optional(),
    },
    async ({ problemSelector, from, to, pageSize }) =>
      jsonResult(
        await deps.client.classic.get("/api/v2/problems", {
          problemSelector,
          from: from ?? "now-2h",
          to,
          pageSize: pageSize ?? 50,
        }),
      ),
  );

  server.tool(
    "get_problem",
    "Get full details of one problem, including root cause and affected entities.",
    { problemId: z.string().describe("The problem id.") },
    async ({ problemId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/problems/${encodeURIComponent(problemId)}`)),
  );
}
```

- [ ] **Step 4: Register**; **Step 5: Run green**; **Step 6: Commit** — `git commit -m "feat: problems tools"`.

---

### Task 12: Logs tool (`search_logs` via DQL)

**Files:** Create `src/tools/logs.ts`; Modify `registry.ts`; Test `test/tools/logs.test.ts`.

- [ ] **Step 1: Failing test** — mock `query:execute` → `SUCCEEDED` with `{ records: [{ content: "boom", loglevel: "ERROR" }] }`; assert `search_logs` output contains `boom`.
- [ ] **Step 2: Run red** — `npm test -- tools/logs`.
- [ ] **Step 3: Implement `src/tools/logs.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

function dqlString(v: string): string {
  return v.replace(/"/g, '\\"');
}

export function registerLogsTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "search_logs",
    "Search logs in Grail via DQL. Builds a 'fetch logs' query with optional filters. For advanced needs use execute_dql.",
    {
      contains: z.string().optional().describe("Substring to match in log content."),
      loglevel: z.string().optional().describe("e.g. 'ERROR', 'WARN'."),
      host: z.string().optional().describe("Host name to filter by (dt.host.name)."),
      from: z.string().optional().describe("Timeframe start, e.g. 'now-1h' (default)."),
      limit: z.number().int().positive().max(1000).optional().describe("Max rows (default 100)."),
    },
    async ({ contains, loglevel, host, from, limit }) => {
      const filters: string[] = [];
      if (loglevel) filters.push(`loglevel == "${dqlString(loglevel)}"`);
      if (host) filters.push(`dt.host.name == "${dqlString(host)}"`);
      if (contains) filters.push(`contains(content, "${dqlString(contains)}")`);
      let q = `fetch logs, from:${from ?? "now-1h"}`;
      if (filters.length) q += ` | filter ${filters.join(" and ")}`;
      q += ` | sort timestamp desc | limit ${limit ?? 100}`;
      const result = await deps.client.dqlExecute(q, { maxResultRecords: limit ?? 100 });
      return jsonResult({ query: q, recordCount: result.records.length, records: result.records });
    },
  );
}
```

- [ ] **Step 4: Register**; **Step 5: Run green**; **Step 6: Commit** — `git commit -m "feat: search_logs via DQL"`.

---

### Task 13: Traces/spans tools (`search_spans`, `get_trace` via DQL)

**Files:** Create `src/tools/traces.ts`; Modify `registry.ts`; Test `test/tools/traces.test.ts`.

- [ ] **Step 1: Failing test** — mock `query:execute` → `SUCCEEDED` with `{ records: [{ "trace.id": "T1", "span.name": "GET /x" }] }`; assert `get_trace` output contains `GET /x`.
- [ ] **Step 2: Run red** — `npm test -- tools/traces`.
- [ ] **Step 3: Implement `src/tools/traces.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";

function dqlString(v: string): string {
  return v.replace(/"/g, '\\"');
}

export function registerTracesTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "search_spans",
    "Search distributed-tracing spans in Grail via DQL ('fetch spans'). Filter by service, status, or duration.",
    {
      service: z.string().optional().describe("Service name (dt.entity.service.name or service.name)."),
      onlyErrors: z.boolean().optional().describe("If true, only failed spans."),
      minDurationMs: z.number().optional().describe("Minimum span duration in ms."),
      from: z.string().optional().describe("Timeframe start (default 'now-1h')."),
      limit: z.number().int().positive().max(1000).optional().describe("Max rows (default 100)."),
    },
    async ({ service, onlyErrors, minDurationMs, from, limit }) => {
      const filters: string[] = [];
      if (service) filters.push(`service.name == "${dqlString(service)}"`);
      if (onlyErrors) filters.push(`request.is_failed == true`);
      if (minDurationMs) filters.push(`duration >= ${minDurationMs}ms`);
      let q = `fetch spans, from:${from ?? "now-1h"}`;
      if (filters.length) q += ` | filter ${filters.join(" and ")}`;
      q += ` | sort duration desc | limit ${limit ?? 100}`;
      const result = await deps.client.dqlExecute(q, { maxResultRecords: limit ?? 100 });
      return jsonResult({ query: q, recordCount: result.records.length, records: result.records });
    },
  );

  server.tool(
    "get_trace",
    "Fetch all spans for a single trace id (ordered by start time) for latency/root-cause analysis.",
    {
      traceId: z.string().describe("The trace.id value."),
      from: z.string().optional().describe("Timeframe start (default 'now-4h')."),
    },
    async ({ traceId, from }) => {
      const q = `fetch spans, from:${from ?? "now-4h"} | filter trace.id == "${dqlString(traceId)}" | sort start_time asc | limit 1000`;
      const result = await deps.client.dqlExecute(q, { maxResultRecords: 1000 });
      return jsonResult({ query: q, spanCount: result.records.length, spans: result.records });
    },
  );
}
```

- [ ] **Step 4: Register**; **Step 5: Run green**; **Step 6: Commit** — `git commit -m "feat: search_spans and get_trace via DQL"`.

> **Implementation note:** the exact span field names (`service.name`, `request.is_failed`, `duration`, `start_time`, `trace.id`) must be confirmed via `fetch spans | fieldsExtract` or the Fieldsets spec/live probe during this task. Adjust to the tenant's actual span schema.

---

### Task 14: Vulnerabilities tools (read-only)

**Files:** Create `src/tools/vulnerabilities.ts`; Modify `registry.ts`; Test `test/tools/vulnerabilities.test.ts`.

Endpoints: read `specs/platform/platform_vulnerabilities_v1.yaml` to confirm exact paths (e.g. `/platform/vulnerabilities/v1/...`). Implement `list_vulnerabilities` and `get_vulnerability` as platform GETs.

- [ ] **Step 1: Failing test** — mock the list endpoint (path from spec) → `{ items: [{ id: "V-1", title: "Log4Shell" }] }`; assert output contains `Log4Shell`.
- [ ] **Step 2: Run red** — `npm test -- tools/vulnerabilities`.
- [ ] **Step 3: Implement** following the metrics-tool shape but using `deps.client.platform.get(...)` and the spec-confirmed paths. Both tools are read-only (no `requireWrites`).
- [ ] **Step 4: Register**; **Step 5: Run green**; **Step 6: Commit** — `git commit -m "feat: vulnerabilities tools (read-only)"`.

> **Implementation note:** confirm list/detail paths and query params from the spec before writing the handler; do not guess the path.

---

# Phase C — Configuration / management tools

### Task 15: Settings 2.0 tools (schema-driven)

**Files:** Create `src/tools/settings.ts`; Modify `registry.ts`; Test `test/tools/settings.test.ts`.

Endpoints (classic v2): `GET /api/v2/settings/schemas`, `GET /api/v2/settings/schemas/{schemaId}`, `GET /api/v2/settings/objects?schemaIds=&scopes=`, `GET /api/v2/settings/objects/{objectId}`, `POST /api/v2/settings/objects` (array body), `PUT /api/v2/settings/objects/{objectId}`, `DELETE /api/v2/settings/objects/{objectId}`. Validation: `POST /api/v2/settings/objects?validateOnly=true`.

- [ ] **Step 1: Failing test** — mock `GET /api/v2/settings/schemas` → `{ items: [{ schemaId: "builtin:tags", displayName: "Tags" }] }`; assert `list_settings_schemas` contains `builtin:tags`. Add a second test: with `enableWrites:false`, `create_settings_object` returns an error mentioning `DT_ENABLE_WRITES`.

```ts
const res = await client.callTool({
  name: "create_settings_object",
  arguments: {
    schemaId: "builtin:tags",
    scope: "environment",
    value: {},
  },
});
expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
```

(Note: callTool surfaces handler errors as result content with `isError`; assert on the text.)

- [ ] **Step 2: Run red** — `npm test -- tools/settings`.
- [ ] **Step 3: Implement `src/tools/settings.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

export function registerSettingsTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "list_settings_schemas",
    "List Settings 2.0 schema ids (classic). These identify configurable settings types.",
    { pageSize: z.number().int().positive().max(500).optional() },
    async ({ pageSize }) =>
      jsonResult(await deps.client.classic.get("/api/v2/settings/schemas", { pageSize: pageSize ?? 500 })),
  );

  server.tool(
    "get_settings_schema",
    "Get the full JSON schema for a Settings 2.0 schemaId. Use this to construct a valid 'value' before writing.",
    { schemaId: z.string().describe("e.g. 'builtin:tags' or 'builtin:anomaly-detection.services'.") },
    async ({ schemaId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/settings/schemas/${encodeURIComponent(schemaId)}`)),
  );

  server.tool(
    "list_settings_objects",
    "List Settings 2.0 objects, filtered by schema and/or scope.",
    {
      schemaIds: z.string().optional().describe("Comma-separated schema ids."),
      scopes: z.string().optional().describe("Comma-separated scopes, e.g. 'environment' or a HOST-xxx id."),
      pageSize: z.number().int().positive().max(500).optional(),
    },
    async ({ schemaIds, scopes, pageSize }) =>
      jsonResult(
        await deps.client.classic.get("/api/v2/settings/objects", {
          schemaIds,
          scopes,
          pageSize: pageSize ?? 100,
          fields: "objectId,value,scope,schemaId",
        }),
      ),
  );

  server.tool(
    "get_settings_object",
    "Get one Settings 2.0 object by objectId.",
    { objectId: z.string() },
    async ({ objectId }) =>
      jsonResult(await deps.client.classic.get(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`)),
  );

  server.tool(
    "validate_settings_object",
    "Validate a Settings 2.0 object payload WITHOUT persisting it (validateOnly=true). Returns constraint violations if invalid. Always safe (read-only).",
    {
      schemaId: z.string(),
      scope: z.string().describe("e.g. 'environment' or an entity id."),
      value: z.record(z.unknown()).describe("The settings value object matching the schema."),
    },
    async ({ schemaId, scope, value }) =>
      jsonResult(
        await deps.client.classic.post("/api/v2/settings/objects", [{ schemaId, scope, value }], {
          validateOnly: true,
        }),
      ),
  );

  server.tool(
    "create_settings_object",
    "Create a Settings 2.0 object (WRITE). Validate first with validate_settings_object.",
    {
      schemaId: z.string(),
      scope: z.string(),
      value: z.record(z.unknown()),
    },
    async ({ schemaId, scope, value }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.post("/api/v2/settings/objects", [{ schemaId, scope, value }]));
    },
  );

  server.tool(
    "update_settings_object",
    "Update an existing Settings 2.0 object by objectId (WRITE).",
    { objectId: z.string(), value: z.record(z.unknown()) },
    async ({ objectId, value }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.classic.put(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`, { value }),
      );
    },
  );

  server.tool(
    "delete_settings_object",
    "Delete a Settings 2.0 object by objectId (WRITE, destructive).",
    { objectId: z.string() },
    async ({ objectId }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.classic.del(`/api/v2/settings/objects/${encodeURIComponent(objectId)}`));
    },
  );
}
```

- [ ] **Step 4: Register**; **Step 5: Run green** — `npm test -- tools/settings`; **Step 6: Commit** — `git commit -m "feat: Settings 2.0 tools (schema-driven, write-gated)"`.

---

### Task 16: Dashboards tools (Document Service)

**Files:** Create `src/tools/documents.ts` (shared helper) and `src/tools/dashboards.ts`; Modify `registry.ts`; Test `test/tools/dashboards.test.ts`.

Endpoints (platform): `GET /platform/document/v1/documents?filter=type=='dashboard'`, `GET /platform/document/v1/documents/{id}`, `GET /platform/document/v1/documents/{id}/content`, `POST /platform/document/v1/documents` (multipart OR JSON — confirm in `specs/platform/platform_document_v1.yaml`), `PATCH/PUT /documents/{id}`, `DELETE /documents/{id}`.

- [ ] **Step 1: Failing test** — mock `GET /platform/document/v1/documents` → `{ documents: [{ id: "D1", name: "Ops", type: "dashboard" }] }`; assert `list_dashboards` contains `Ops`. Add write-gate test for `create_dashboard` (expect `DT_ENABLE_WRITES` message when writes off).
- [ ] **Step 2: Run red** — `npm test -- tools/dashboards`.
- [ ] **Step 3: Implement `src/tools/dashboards.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const DOC = "/platform/document/v1/documents";

export function registerDashboardTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "list_dashboards",
    "List dashboard documents (platform Document Service).",
    { pageSize: z.number().int().positive().max(100).optional() },
    async ({ pageSize }) =>
      jsonResult(
        await deps.client.platform.get(DOC, {
          filter: "type=='dashboard'",
          "page-size": pageSize ?? 50,
        }),
      ),
  );

  server.tool(
    "get_dashboard",
    "Get a dashboard document's metadata and JSON content by id.",
    { id: z.string() },
    async ({ id }) => {
      const meta = await deps.client.platform.get(`${DOC}/${encodeURIComponent(id)}`);
      const content = await deps.client.platform.get(`${DOC}/${encodeURIComponent(id)}/content`);
      return jsonResult({ meta, content });
    },
  );

  server.tool(
    "create_dashboard",
    "Create a dashboard document (WRITE). 'content' is the dashboard JSON; copy an existing dashboard's content as a template first.",
    {
      name: z.string().describe("Dashboard display name."),
      content: z.record(z.unknown()).describe("Dashboard JSON content object."),
    },
    async ({ name, content }) => {
      requireWrites(deps.config);
      return jsonResult(
        await deps.client.platform.post(DOC, {
          name,
          type: "dashboard",
          content,
        }),
      );
    },
  );

  server.tool(
    "update_dashboard",
    "Update a dashboard document by id (WRITE). Requires the current version for optimistic locking.",
    {
      id: z.string(),
      version: z.number().int().describe("Current document version (from get_dashboard)."),
      name: z.string().optional(),
      content: z.record(z.unknown()).optional(),
    },
    async ({ id, version, name, content }) => {
      requireWrites(deps.config);
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (content !== undefined) body.content = content;
      return jsonResult(
        await deps.client.platform.put(`${DOC}/${encodeURIComponent(id)}`, body, {
          "optimistic-locking-version": version,
        }),
      );
    },
  );

  server.tool(
    "delete_dashboard",
    "Delete (trash) a dashboard document by id (WRITE, destructive).",
    { id: z.string() },
    async ({ id }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.del(`${DOC}/${encodeURIComponent(id)}`));
    },
  );
}
```

- [ ] **Step 4: Register**; **Step 5: Run green** — `npm test -- tools/dashboards`; **Step 6: Commit** — `git commit -m "feat: dashboard document tools (write-gated)"`.

> **Implementation note (critical):** the Document Service create/update body may require **multipart/form-data** (a metadata part + a content part) rather than a flat JSON body, and the version param name may differ. Confirm against `specs/platform/platform_document_v1.yaml` and, during the live-smoke task, by fetching an existing dashboard and round-tripping it. Adjust the request shape (and possibly `DynatraceClient` to support multipart) before finishing this task.

---

### Task 17: Notebooks tools (Document Service)

**Files:** Create `src/tools/notebooks.ts`; Modify `registry.ts`; Test `test/tools/notebooks.test.ts`.

Identical to Task 16 but `type: "notebook"` and filter `type=='notebook'`. Tools: `list_notebooks`, `get_notebook`, `create_notebook*`, `update_notebook*`, `delete_notebook*`.

- [ ] **Step 1: Failing test** — mock list → `{ documents: [{ id: "N1", name: "Investigation", type: "notebook" }] }`; assert `list_notebooks` contains `Investigation`.
- [ ] **Step 2: Run red** — `npm test -- tools/notebooks`.
- [ ] **Step 3: Implement** — copy Task 16's module, rename `register*` → `registerNotebookTools`, swap `dashboard`→`notebook` in tool names/descriptions, the `filter` value, and the `type` field. Same write gating and the same multipart note applies.
- [ ] **Step 4: Register**; **Step 5: Run green**; **Step 6: Commit** — `git commit -m "feat: notebook document tools (write-gated)"`.

---

### Task 18: SLO tools (platform SLO v1)

**Files:** Create `src/tools/slos.ts`; Modify `registry.ts`; Test `test/tools/slos.test.ts`.

Endpoints (platform): `GET /platform/slo/v1/slos`, `GET /platform/slo/v1/slos/{id}`, `POST /platform/slo/v1/slos`, `PUT /platform/slo/v1/slos/{id}`, `DELETE /platform/slo/v1/slos/{id}`, `GET /platform/slo/v1/slos/evaluation`, `GET /platform/slo/v1/objective-templates`. Confirm body shapes in `specs/platform/platform_slo_v1.yaml`.

- [ ] **Step 1: Failing test** — mock `GET /platform/slo/v1/slos` → `{ slos: [{ id: "S1", name: "Checkout availability" }] }`; assert `list_slos` contains `Checkout availability`. Write-gate test for `create_slo`.
- [ ] **Step 2: Run red** — `npm test -- tools/slos`.
- [ ] **Step 3: Implement `src/tools/slos.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./registry.js";
import { jsonResult } from "../util/result.js";
import { requireWrites } from "../util/guards.js";

const SLO = "/platform/slo/v1/slos";

export function registerSloTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "list_slos",
    "List Service-Level Objectives (platform SLO v1).",
    { pageSize: z.number().int().positive().max(500).optional() },
    async ({ pageSize }) => jsonResult(await deps.client.platform.get(SLO, { "page-size": pageSize ?? 100 })),
  );

  server.tool("get_slo", "Get one SLO by id (platform SLO v1).", { id: z.string() }, async ({ id }) =>
    jsonResult(await deps.client.platform.get(`${SLO}/${encodeURIComponent(id)}`)),
  );

  server.tool(
    "evaluate_slo",
    "Get the current evaluation/error-budget for SLOs (platform SLO v1).",
    { from: z.string().optional(), to: z.string().optional() },
    async ({ from, to }) => jsonResult(await deps.client.platform.get(`${SLO}/evaluation`, { from, to })),
  );

  server.tool("list_objective_templates", "List SLO objective templates (platform SLO v1).", {}, async () =>
    jsonResult(await deps.client.platform.get("/platform/slo/v1/objective-templates")),
  );

  server.tool(
    "create_slo",
    "Create an SLO (WRITE). Body fields per the SLO v1 spec (name, criteria, target, etc.).",
    { slo: z.record(z.unknown()).describe("SLO definition object matching platform SLO v1.") },
    async ({ slo }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.post(SLO, slo));
    },
  );

  server.tool(
    "update_slo",
    "Update an SLO by id (WRITE).",
    { id: z.string(), slo: z.record(z.unknown()) },
    async ({ id, slo }) => {
      requireWrites(deps.config);
      return jsonResult(await deps.client.platform.put(`${SLO}/${encodeURIComponent(id)}`, slo));
    },
  );

  server.tool("delete_slo", "Delete an SLO by id (WRITE, destructive).", { id: z.string() }, async ({ id }) => {
    requireWrites(deps.config);
    return jsonResult(await deps.client.platform.del(`${SLO}/${encodeURIComponent(id)}`));
  });
}
```

- [ ] **Step 4: Register**; **Step 5: Run green**; **Step 6: Commit** — `git commit -m "feat: SLO tools (platform v1, write-gated)"`.

---

### Task 19: Synthetic tools (platform Synthetic v1)

**Files:** Create `src/tools/synthetic.ts`; Modify `registry.ts`; Test `test/tools/synthetic.test.ts`.

Endpoints (platform): `GET /platform/synthetic/v1/monitors`, `GET /monitors/{monitor-id}`, `POST /monitors`, `PUT /monitors/{monitor-id}`, `DELETE /monitors/{monitor-id}`, `GET /locations`, `GET /nodes`. Confirm in `specs/platform/platform_synthetic_v1.yaml`.

- [ ] **Step 1: Failing test** — mock `GET /platform/synthetic/v1/monitors` → `{ monitors: [{ id: "M1", name: "Homepage" }] }`; assert `list_monitors` contains `Homepage`. Write-gate test for `create_monitor`.
- [ ] **Step 2: Run red** — `npm test -- tools/synthetic`.
- [ ] **Step 3: Implement `src/tools/synthetic.ts`** following the SLO module shape:
  - `list_monitors` (GET `/platform/synthetic/v1/monitors`), `get_monitor` (GET `/monitors/{id}`),
  - `list_synthetic_locations` (GET `/locations`), `list_synthetic_nodes` (GET `/nodes`) — all read-only,
  - `create_monitor*`/`update_monitor*`/`delete_monitor*` — write-gated with `requireWrites(deps.config)`, body `z.record(z.unknown())` named `monitor`.
- [ ] **Step 4: Register**; **Step 5: Run green**; **Step 6: Commit** — `git commit -m "feat: synthetic tools (platform v1, write-gated)"`.

---

# Phase D — Wrap-up

### Task 20: README, end-to-end typecheck, MCP registration

**Files:** Create `README.md`; Create `test/tools/registry-count.test.ts`.

- [ ] **Step 1: Write a test asserting the full tool set is registered**

```ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools } from "../../src/tools/registry.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://p",
  classicUrl: "https://c",
  platformToken: "p",
  apiToken: "a",
  enableWrites: false,
  timeoutMs: 1000,
};

describe("registry", () => {
  it("exposes the expected tools", async () => {
    const mcp = new McpServer({ name: "t", version: "0" });
    registerAllTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([mcp.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "execute_dql",
      "list_metrics",
      "list_hosts",
      "list_problems",
      "search_logs",
      "search_spans",
      "get_trace",
      "list_settings_schemas",
      "create_settings_object",
      "list_dashboards",
      "create_dashboard",
      "list_notebooks",
      "list_slos",
      "create_slo",
      "list_monitors",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
```

- [ ] **Step 2: Run red** — `npm test -- registry-count` (fails until all registers are wired). Wire any missing `register*` calls in `registry.ts`.
- [ ] **Step 3: Run green** — `npm test -- registry-count`; Expected: PASS.
- [ ] **Step 4: Write `README.md`** with: overview, the two-host/two-token model, `.env` setup (copy `.env.example`), required token scopes (classic: `metrics.read`, `slo.read/write`, `logs.read`, `settings.read/write`, `entities.read`, `problems.read`, `ReadConfig/WriteConfig`; platform: `storage:*:read`, `document:documents:read/write`), build/run (`npm run build` then `node dist/index.js`), the read-only-by-default note (`DT_ENABLE_WRITES=true` to enable writes), and the Claude Code/Desktop MCP config snippet:

```json
{
  "mcpServers": {
    "dynatrace-saas": {
      "command": "node",
      "args": ["/Users/nasr/mycode/personal/saas-mcp/dist/index.js"],
      "env": {
        "DT_PLATFORM_URL": "https://asn8731h.sprint.apps.dynatracelabs.com",
        "DT_CLASSIC_URL": "https://asn8731h.sprint.dynatracelabs.com",
        "DT_PLATFORM_TOKEN": "dt0s16...",
        "DT_API_TOKEN": "dt0c01...",
        "DT_ENABLE_WRITES": "false"
      }
    }
  }
}
```

- [ ] **Step 5: Full verification** — Run: `npm run typecheck && npm test && npm run build`; Expected: typecheck 0 errors, all tests pass, `dist/index.js` produced.
- [ ] **Step 6: Commit** — `git commit -m "docs: README + full registry test; build verified"`.

---

### Task 21: Live smoke test (optional, gated)

**Files:** Create `test/live/smoke.test.ts`.

- [ ] **Step 1: Write a gated live test**

```ts
import { describe, it, expect } from "vitest";
import "dotenv/config";
import { loadConfig } from "../../src/config.js";
import { DynatraceClient } from "../../src/http/client.js";

const RUN = process.env.DT_LIVE_TEST === "1";
describe.runIf(RUN)("live smoke (read-only)", () => {
  const client = new DynatraceClient(loadConfig());

  it("lists settings schemas (classic)", async () => {
    const r = await client.classic.get<{ items: unknown[] }>("/api/v2/settings/schemas", { pageSize: 1 });
    expect(Array.isArray(r.items)).toBe(true);
  });

  it("runs a trivial DQL query (platform)", async () => {
    const r = await client.dqlExecute("fetch dt.entity.host | limit 1");
    expect(Array.isArray(r.records)).toBe(true);
  });

  it("lists dashboards (platform document service)", async () => {
    const r = await client.platform.get("/platform/document/v1/documents", {
      filter: "type=='dashboard'",
      "page-size": 1,
    });
    expect(r).toBeDefined();
  });
});
```

- [ ] **Step 2: Run gated** — Run: `DT_LIVE_TEST=1 npm test -- live/smoke`
      Expected: PASS against the sprint tenant (validates real paths; if any fails, fix the corresponding tool's path/params per the spec — this is the task that resolves the §10 open items: Document content shape, metric query params, DQL field names).

- [ ] **Step 3: Commit** — `git commit -m "test: gated live smoke tests for classic + platform"`.

---

## Self-Review (completed by plan author)

**Spec coverage:**

- Dual-host/dual-token client → Tasks 2,4. DQL async → Task 5. Write gate → Tasks 6 + each write tool. Errors → Task 3.
- Observability (DQL, logs, traces, metrics, entities/hosts, problems, vulnerabilities) → Tasks 8–14.
- Config (settings, dashboards, notebooks, SLOs, synthetic) → Tasks 15–19.
- Schema-driven settings → Task 15. Read-only default → Task 6 + write tools. Testing/TDD → every task. Live smoke → Task 21. README/registration → Task 20.
- §10 open items (document content shape, metric query verb, DQL field names) explicitly resolved in Tasks 16/9/13 notes + Task 21.

**Placeholder scan:** No "TBD/handle edge cases" left; the few "confirm against spec" notes are deliberate, scoped verification steps with a named spec file, not vague hand-waving. Tasks 14/17/19 reuse a fully-specified earlier module shape and name the exact differences (acceptable: the reference module's code is shown in this same plan).

**Type consistency:** `Config`, `HostClient`, `QueryParams`, `DqlResult`, `ToolDeps`, `jsonResult`, `requireWrites`, `DynatraceClient.{classic,platform,dqlExecute}` are defined once (Tasks 2,4,5,6,7) and used consistently. Every tool module uses the same `register*(server, deps)` signature and the `server.tool(name, desc, shape, handler)` SDK call.

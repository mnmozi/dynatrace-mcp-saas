import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { registerDriftTools } from "../../src/tools/drift.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const CLASSIC = "https://classic.example.com";
const PLATFORM = "https://plat.example.com";

const cfg: Config = {
  classicUrl: CLASSIC,
  platformUrl: PLATFORM,
  apiToken: "AT",
  platformToken: "PT",
  enableWrites: false,
  timeoutMs: 5000,
};

// ── Load the real committed manifest to pick real schema IDs ──────────────────
const SPECS_DIR = fileURLToPath(new URL("../../specs/", import.meta.url));

interface ManifestSchema {
  version: string;
  displayName: string;
}
interface Manifest {
  count: number;
  schemas: Record<string, ManifestSchema>;
}

// We'll load these in beforeAll
let manifest: Manifest;
let realSchemaIds: string[];
let removedId: string; // will be absent from live response → should appear in "removed"
let changedId: string; // will have bumped version → should appear in "changed"
let keptId: string; // will remain identical → should NOT appear in drift
const newId = "builtin:__drift_test__"; // brand-new → should appear in "added"

// ── MSW server (starts empty; handlers added per-test) ────────────────────────
const mswServer = setupServer();

beforeAll(async () => {
  const text = await readFile(SPECS_DIR + "settings-schemas/manifest.json", "utf8");
  manifest = JSON.parse(text) as Manifest;
  realSchemaIds = Object.keys(manifest.schemas);

  // Pick 3 distinct real IDs
  removedId = realSchemaIds[0];
  changedId = realSchemaIds[1];
  keptId = realSchemaIds[2];

  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(): Promise<Client> {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerDriftTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getText(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as Array<{ text: string }>)[0].text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool 1: check_settings_schema_drift
// ─────────────────────────────────────────────────────────────────────────────

describe("check_settings_schema_drift", () => {
  it("detects added, removed, and changed schemas vs committed manifest", async () => {
    // Build live response:
    //   - omit removedId (→ appears in "removed")
    //   - bump version of changedId (→ appears in "changed")
    //   - keep all others from manifest EXCEPT removedId
    //   - add the brand-new newId (→ appears in "added")
    const changedVersion = manifest.schemas[changedId].version + "-BUMPED";

    const liveItems = realSchemaIds
      .filter((id) => id !== removedId)
      .map((id) => ({
        schemaId: id,
        latestSchemaVersion:
          id === changedId ? changedVersion : manifest.schemas[id].version,
      }));

    // Add the brand-new schema
    liveItems.push({ schemaId: newId, latestSchemaVersion: "0.0.1" });

    mswServer.use(
      http.get(`${CLASSIC}/api/v2/settings/schemas`, () =>
        HttpResponse.json({ items: liveItems }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "check_settings_schema_drift",
      arguments: {},
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as {
      baselineCount: number;
      liveCount: number;
      versionDrift: {
        added: string[];
        removed: string[];
        changed: Array<{ key: string; from: string; to: string }>;
      };
    };

    // The brand-new ID is in live but not committed → added
    expect(parsed.versionDrift.added).toContain(newId);

    // removedId is in committed but not in live → removed
    expect(parsed.versionDrift.removed).toContain(removedId);

    // changedId has a different version → changed
    const changedEntry = parsed.versionDrift.changed.find((e) => e.key === changedId);
    expect(changedEntry).toBeDefined();
    expect(changedEntry?.from).toBe(manifest.schemas[changedId].version);
    expect(changedEntry?.to).toBe(changedVersion);

    // keptId stays the same → NOT in added/removed/changed
    expect(parsed.versionDrift.added).not.toContain(keptId);
    expect(parsed.versionDrift.removed).not.toContain(keptId);
    expect(parsed.versionDrift.changed.map((e) => e.key)).not.toContain(keptId);
  });

  it("includes structuralDiff note when schemaId has no committed snapshot", async () => {
    // Return minimal live items to satisfy the schemas list call
    mswServer.use(
      http.get(`${CLASSIC}/api/v2/settings/schemas`, () =>
        HttpResponse.json({ items: [] }),
      ),
      // Return a minimal live schema for the requested schemaId
      http.get(`${CLASSIC}/api/v2/settings/schemas/builtin%3Asome.nonexistent.schema`, () =>
        HttpResponse.json({ properties: { foo: {} }, required: ["foo"] }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "check_settings_schema_drift",
      arguments: { schemaId: "builtin:some.nonexistent.schema" },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as {
      structuralDiff: { note?: string };
    };
    expect(parsed.structuralDiff).toBeDefined();
    expect(parsed.structuralDiff.note).toMatch(/no committed snapshot/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2: check_api_spec_drift — catalog overview
// ─────────────────────────────────────────────────────────────────────────────

describe("check_api_spec_drift — catalog overview", () => {
  it("detects added platform spec not in committed files and removed committed specs not in catalog", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/metadata/v1/swagger-ui.json`, () =>
        HttpResponse.json({
          urls: [
            { name: "SLO", url: "/platform/slo/v1/openapi.yaml" },
            { name: "New", url: "/platform/brandnew/v1/openapi.yaml" },
          ],
        }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "check_api_spec_drift",
      arguments: {},
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as {
      platformDrift: { added: string[]; removed: string[] };
    };

    // The brand-new spec is in the live catalog but not committed
    expect(parsed.platformDrift.added).toContain("platform_brandnew_v1");

    // The mock catalog only lists slo + brandnew, so every other committed stem
    // (there are 29 committed platform specs) should appear as removed.
    // At minimum we know platform_automation_v1 is committed but not in mock catalog.
    expect(parsed.platformDrift.removed.length).toBeGreaterThan(0);
    // platform_slo_v1 IS in the mock catalog, so NOT removed
    expect(parsed.platformDrift.removed).not.toContain("platform_slo_v1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 2: check_api_spec_drift — single spec deep-diff
// ─────────────────────────────────────────────────────────────────────────────

describe("check_api_spec_drift — single spec deep-diff", () => {
  it("reports added and removed operations between committed and live platform spec", async () => {
    // Mock catalog so stem "platform_slo_v1" resolves
    const liveYaml = `
openapi: "3.0.0"
info:
  title: "SLO Mock"
  version: "999"
paths:
  /slos:
    get:
      summary: "List SLOs"
  /slos/brand-new-endpoint:
    post:
      summary: "Brand new operation not in committed spec"
`;

    mswServer.use(
      http.get(`${PLATFORM}/platform/metadata/v1/swagger-ui.json`, () =>
        HttpResponse.json({
          urls: [{ name: "SLO", url: "/platform/slo/v1/openapi.yaml" }],
        }),
      ),
      http.get(`${PLATFORM}/platform/slo/v1/openapi.yaml`, () =>
        new HttpResponse(liveYaml, {
          headers: { "Content-Type": "application/yaml" },
        }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "check_api_spec_drift",
      arguments: { spec: "platform_slo_v1" },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as {
      spec: string;
      operationDrift: { added: string[]; removed: string[] };
    };

    expect(parsed.spec).toBe("platform_slo_v1");

    // The mock live spec has "POST /slos/brand-new-endpoint" — not in committed → added
    expect(parsed.operationDrift.added).toContain("POST /slos/brand-new-endpoint");

    // The committed spec has many paths that are NOT in the mock live spec → removed
    // At minimum, operations other than GET /slos should be in removed
    expect(parsed.operationDrift.removed.length).toBeGreaterThan(0);
  });

  it("returns error for unknown spec stem", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/metadata/v1/swagger-ui.json`, () =>
        HttpResponse.json({ urls: [] }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "check_api_spec_drift",
      arguments: { spec: "platform_nonexistent_v99" },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as { error: string };
    expect(parsed.error).toMatch(/no live platform spec matches/);
  });

  it("returns error for completely unknown spec stem (not platform_ or environment-api-*)", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/metadata/v1/swagger-ui.json`, () =>
        HttpResponse.json({ urls: [] }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "check_api_spec_drift",
      arguments: { spec: "completely-unknown" },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as { error: string };
    expect(parsed.error).toMatch(/unknown spec stem/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool 3: validate_against_live_schema
// ─────────────────────────────────────────────────────────────────────────────

describe("validate_against_live_schema", () => {
  it("reports invalid with violations, correct correctedValue, and requiredMissing", async () => {
    mswServer.use(
      http.get(`${CLASSIC}/api/v2/settings/schemas/builtin%3Atest.schema`, () =>
        HttpResponse.json({
          properties: { a: { type: "integer" }, b: { type: "string" } },
          required: ["a"],
        }),
      ),
      http.post(`${CLASSIC}/api/v2/settings/objects`, () =>
        HttpResponse.json(
          {
            error: {
              constraintViolations: [
                { path: "c", message: "Unexpected property." },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "validate_against_live_schema",
      arguments: {
        schemaId: "builtin:test.schema",
        value: { a: 1, c: 2 },
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as {
      valid: boolean;
      violations: Array<{ path: string; message: string }>;
      requiredMissing: string[];
      correctedValue: Record<string, unknown>;
    };

    expect(parsed.valid).toBe(false);
    expect(parsed.violations).toHaveLength(1);
    expect(parsed.violations[0].path).toBe("c");

    // a is present so not in requiredMissing
    expect(parsed.requiredMissing).toEqual([]);

    // correctedValue should keep a (known property), drop c (unknown), NOT add b (not provided)
    expect(parsed.correctedValue).toEqual({ a: 1 });
  });

  it("reports valid when the API accepts the object", async () => {
    mswServer.use(
      http.get(`${CLASSIC}/api/v2/settings/schemas/builtin%3Avalid.schema`, () =>
        HttpResponse.json({
          properties: { x: { type: "string" } },
          required: [],
        }),
      ),
      http.post(`${CLASSIC}/api/v2/settings/objects`, () =>
        HttpResponse.json([{ objectId: "OBJ-1", code: 200 }], { status: 200 }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "validate_against_live_schema",
      arguments: {
        schemaId: "builtin:valid.schema",
        value: { x: "hello" },
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as {
      valid: boolean;
      violations: unknown[];
    };

    expect(parsed.valid).toBe(true);
    expect(parsed.violations).toHaveLength(0);
  });

  it("reports requiredMissing when a required property is absent from value", async () => {
    mswServer.use(
      http.get(`${CLASSIC}/api/v2/settings/schemas/builtin%3Areq.schema`, () =>
        HttpResponse.json({
          properties: { name: {}, count: {} },
          required: ["name", "count"],
        }),
      ),
      http.post(`${CLASSIC}/api/v2/settings/objects`, () =>
        HttpResponse.json({ error: { constraintViolations: [] } }, { status: 400 }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "validate_against_live_schema",
      arguments: {
        schemaId: "builtin:req.schema",
        value: { name: "foo" },
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(getText(res)) as {
      requiredMissing: string[];
    };

    // "count" is required but absent from value
    expect(parsed.requiredMissing).toContain("count");
    expect(parsed.requiredMissing).not.toContain("name");
  });
});

/**
 * Maintenance script: refresh committed spec/schema snapshots from the live tenant
 * and print a changelog of what changed.
 *
 * Writes ONLY to the local repo (specs/). NEVER modifies the tenant.
 *
 * Usage:
 *   tsx scripts/refresh-snapshots.ts
 *   # or via npm script:
 *   npm run refresh-snapshots
 */

import "dotenv/config";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { DynatraceClient } from "../src/http/client.js";
import { diffStringSets, diffVersionMap } from "../src/util/diff.js";

// ── Path helpers ──────────────────────────────────────────────────────────────

const SPECS_DIR = fileURLToPath(new URL("../specs/", import.meta.url));
const PLATFORM_DIR = `${SPECS_DIR}platform/`;
const CLASSIC_DIR = `${SPECS_DIR}classic/`;
const SETTINGS_DIR = `${SPECS_DIR}settings-schemas/`;

// ── Stem derivation (mirrors how the baseline was originally downloaded) ──────

/**
 * Derive the filename stem for a platform spec URL.
 *
 * Algorithm:
 *   1. Strip leading/trailing slashes from the path.
 *   2. Remove trailing "/openapi.yaml" or "/openapi.yml" segment.
 *   3. Replace every run of non-alphanumeric characters with "_".
 *   4. Trim leading/trailing "_".
 *
 * Example: "/platform/slo/v1/openapi.yaml" → "platform_slo_v1"
 */
function urlToStem(url: string): string {
  let s = url.replace(/^\/+|\/+$/g, ""); // strip leading/trailing slashes
  s = s.replace(/\/openapi\.ya?ml$/i, ""); // remove /openapi.yaml or /openapi.yml
  s = s.replace(/[^a-zA-Z0-9]+/g, "_"); // replace non-alphanumeric runs with _
  s = s.replace(/^_+|_+$/g, ""); // trim surrounding underscores
  return s;
}

/**
 * Redact Dynatrace token-shaped EXAMPLE values (dt0X##.SEG[.SEG]) that are baked into
 * the vendor OpenAPI specs' `example:` fields. These are documentation samples, not real
 * credentials — but GitHub secret scanning / push protection rejects them. Redacting keeps
 * committed snapshots push-safe and idempotent with the scrubbed git history.
 */
const EXAMPLE_TOKEN_RE = /dt0[a-z][0-9]{2}(\.[A-Za-z0-9]{6,}){1,2}/g;
function redactTokens(text: string): string {
  return text.replace(EXAMPLE_TOKEN_RE, "REDACTED-EXAMPLE-TOKEN");
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SwaggerUiEntry {
  name: string;
  url: string;
}

interface SwaggerUiIndex {
  urls: SwaggerUiEntry[];
}

interface SettingsSchemaItem {
  schemaId: string;
  latestSchemaVersion: string;
  displayName: string;
}

interface SettingsSchemaResponse {
  items: SettingsSchemaItem[];
}

interface ManifestSchema {
  version: string;
  displayName: string;
}

interface Manifest {
  source: string;
  count: number;
  schemas: Record<string, ManifestSchema>;
}

// ── Read baseline state before overwriting ────────────────────────────────────

async function readExistingStems(): Promise<string[]> {
  try {
    const entries = await readdir(PLATFORM_DIR);
    return entries
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => f.replace(/\.yaml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

async function readExistingVersions(): Promise<Record<string, string | undefined>> {
  try {
    const raw = await readFile(`${SETTINGS_DIR}manifest.json`, "utf-8");
    const manifest = JSON.parse(raw) as Manifest;
    const out: Record<string, string | undefined> = {};
    for (const [id, info] of Object.entries(manifest.schemas)) {
      out[id] = info.version;
    }
    return out;
  } catch {
    return {};
  }
}

// ── Download helpers ──────────────────────────────────────────────────────────

async function downloadPlatformSpecs(client: DynatraceClient): Promise<string[]> {
  const index = await client.platform.get<SwaggerUiIndex>("/platform/metadata/v1/swagger-ui.json");

  const stems: string[] = [];

  await mkdir(PLATFORM_DIR, { recursive: true });

  for (const entry of index.urls) {
    if (!entry.url.startsWith("/platform")) {
      // Skip non-platform entries (classic explorer HTML links)
      continue;
    }

    const stem = urlToStem(entry.url);
    stems.push(stem);

    // Fetch as raw text to preserve YAML formatting; redact example tokens before writing.
    const content = await client.platform.getText(entry.url);
    await writeFile(`${PLATFORM_DIR}${stem}.yaml`, redactTokens(content), "utf-8");
  }

  return stems.sort();
}

async function downloadClassicSpecs(client: DynatraceClient): Promise<void> {
  await mkdir(CLASSIC_DIR, { recursive: true });

  const v2 = await client.classic.get<unknown>("/api/v2/spec3.json");
  await writeFile(`${CLASSIC_DIR}environment-api-v2.json`, redactTokens(JSON.stringify(v2, null, 2)), "utf-8");

  const v1 = await client.classic.get<unknown>("/api/v1/spec3.json");
  await writeFile(`${CLASSIC_DIR}environment-api-v1.json`, redactTokens(JSON.stringify(v1, null, 2)), "utf-8");
}

async function downloadSettingsManifest(client: DynatraceClient): Promise<Record<string, string | undefined>> {
  const resp = await client.classic.get<SettingsSchemaResponse>("/api/v2/settings/schemas", {
    pageSize: "500",
    fields: "schemaId,latestSchemaVersion,displayName",
  });

  const schemas: Record<string, ManifestSchema> = {};
  for (const item of resp.items.sort((a, b) => a.schemaId.localeCompare(b.schemaId))) {
    schemas[item.schemaId] = {
      version: item.latestSchemaVersion,
      displayName: item.displayName,
    };
  }

  const manifest: Manifest = {
    source: "live",
    count: resp.items.length,
    schemas,
  };

  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(`${SETTINGS_DIR}manifest.json`, JSON.stringify(manifest, null, 2), "utf-8");

  const versions: Record<string, string | undefined> = {};
  for (const [id, info] of Object.entries(schemas)) {
    versions[id] = info.version;
  }
  return versions;
}

// ── Changelog printer ─────────────────────────────────────────────────────────

function printList(label: string, items: string[], max = 20): void {
  if (items.length === 0) return;
  console.log(`  ${label} (${items.length}):`);
  for (const item of items.slice(0, max)) {
    console.log(`    - ${item}`);
  }
  if (items.length > max) {
    console.log(`    ... and ${items.length - max} more`);
  }
}

function printChangelog(
  oldStems: string[],
  newStems: string[],
  oldVersions: Record<string, string | undefined>,
  newVersions: Record<string, string | undefined>,
): void {
  console.log("\n=== REFRESH CHANGELOG ===\n");

  // ── Platform specs ─────────────────────────────────────────────────────────
  const stemDiff = diffStringSets(oldStems, newStems);
  console.log(`Platform specs: ${newStems.length} total`);
  if (stemDiff.added.length === 0 && stemDiff.removed.length === 0) {
    console.log("  No changes to platform spec list.");
  } else {
    printList("Added specs", stemDiff.added);
    printList("Removed specs", stemDiff.removed);
  }

  console.log();

  // ── Settings schemas ───────────────────────────────────────────────────────
  const verDiff = diffVersionMap(oldVersions, newVersions);
  const newCount = Object.keys(newVersions).length;
  console.log(`Settings schemas: ${newCount} total`);
  if (verDiff.added.length === 0 && verDiff.removed.length === 0 && verDiff.changed.length === 0) {
    console.log("  No changes to settings schemas.");
  } else {
    printList("Added schemas", verDiff.added);
    printList("Removed schemas", verDiff.removed);
    if (verDiff.changed.length > 0) {
      console.log(`  Version-changed schemas (${verDiff.changed.length}):`);
      for (const { key, from, to } of verDiff.changed.slice(0, 20)) {
        console.log(`    - ${key}: ${from ?? "(none)"} → ${to ?? "(none)"}`);
      }
      if (verDiff.changed.length > 20) {
        console.log(`    ... and ${verDiff.changed.length - 20} more`);
      }
    }
  }

  console.log("\n=== END CHANGELOG ===\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Loading config...");
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`Config error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const client = new DynatraceClient(cfg);

  // 1. Read baseline BEFORE overwriting
  console.log("Reading existing baselines...");
  const [oldStems, oldVersions] = await Promise.all([readExistingStems(), readExistingVersions()]);
  console.log(`  Existing platform specs: ${oldStems.length}`);
  console.log(`  Existing settings schemas: ${Object.keys(oldVersions).length}`);

  // 2. Re-download everything
  console.log("\nDownloading platform specs...");
  let newStems: string[];
  try {
    newStems = await downloadPlatformSpecs(client);
    console.log(`  Downloaded ${newStems.length} platform specs`);
  } catch (err) {
    console.error(`Failed to download platform specs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("Downloading classic API specs...");
  try {
    await downloadClassicSpecs(client);
    console.log("  Downloaded environment-api-v1.json and environment-api-v2.json");
  } catch (err) {
    console.error(`Failed to download classic specs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log("Downloading settings schemas manifest...");
  let newVersions: Record<string, string | undefined>;
  try {
    newVersions = await downloadSettingsManifest(client);
    console.log(`  Downloaded manifest with ${Object.keys(newVersions).length} schemas`);
  } catch (err) {
    console.error(`Failed to download settings manifest: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 3. Print changelog
  printChangelog(oldStems, newStems, oldVersions, newVersions);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

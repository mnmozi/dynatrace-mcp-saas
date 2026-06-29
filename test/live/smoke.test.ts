import { describe, it, expect, beforeAll } from "vitest";
import "dotenv/config";
import { loadConfig } from "../../src/config.js";
import { DynatraceClient } from "../../src/http/client.js";

const RUN = process.env.DT_LIVE_TEST === "1";

describe.runIf(RUN)("live smoke (read-only)", () => {
  // NOTE: the describe callback is executed at COLLECTION time even when runIf is
  // false, so credential loading must NOT happen here at the top level — it would
  // throw in any environment without creds (e.g. CI) and fail the whole suite.
  // Defer it to beforeAll, which only runs when the suite actually runs (RUN=true).
  let client: DynatraceClient;
  beforeAll(() => {
    client = new DynatraceClient(loadConfig());
  });

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
      filter: "type == 'dashboard'",
      "page-size": 1,
    });
    expect(r).toBeDefined();
  });
});

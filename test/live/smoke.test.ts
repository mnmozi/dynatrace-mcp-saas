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
      filter: "type == 'dashboard'",
      "page-size": 1,
    });
    expect(r).toBeDefined();
  });
});

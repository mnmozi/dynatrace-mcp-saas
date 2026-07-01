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

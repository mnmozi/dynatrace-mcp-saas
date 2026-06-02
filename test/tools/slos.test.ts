import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSloTools } from "../../src/tools/slos.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const PLATFORM = "https://plat.example.com";

const cfg: Config = {
  platformUrl: PLATFORM,
  classicUrl: "https://classic.example.com",
  platformToken: "PT",
  apiToken: "AT",
  enableWrites: false,
  timeoutMs: 5000,
};

const mswServer = setupServer(
  http.get(`${PLATFORM}/platform/slo/v1/slos`, () =>
    HttpResponse.json({ slos: [{ id: "S1", name: "Checkout availability" }] }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerSloTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_slos", () => {
  it("returns SLO list containing the SLO name", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_slos", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Checkout availability");
  });
});

describe("create_slo write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "create_slo",
      arguments: { slo: {} },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

describe("evaluate_slo", () => {
  it("returns inline evaluation result when start responds 200 (no evaluationToken)", async () => {
    const evalResult = {
      metadata: { evaluatedSliQuery: "timeseries sli=avg(dt.host.cpu.idle)" },
      evaluationResults: [{ criteria: "now-7d - now", status: "SUCCESS", value: 99.5, errorBudget: 29.99 }],
      definition: { id: "SLO-1", name: "My SLO" },
    };

    mswServer.use(
      http.post(`${PLATFORM}/platform/slo/v1/slos/evaluation:start`, () =>
        HttpResponse.json(evalResult, { status: 200 }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "evaluate_slo",
      arguments: { id: "SLO-1", timeframeFrom: "now-7d" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SUCCESS");
    expect(text).toContain("99.5");
  });

  it("polls until completion when start responds 202 with evaluationToken", async () => {
    const evalToken = "FQ5aVZERXZNMjR1SzVnPT0ifQ==";
    const evalResult = {
      metadata: { evaluatedSliQuery: "timeseries sli=avg(dt.host.cpu.idle)" },
      evaluationResults: [{ criteria: "now-7d - now", status: "SUCCESS", value: 98.0, errorBudget: 10.0 }],
      definition: { id: "SLO-2", name: "Async SLO" },
    };

    // start → 202 with token
    mswServer.use(
      http.post(`${PLATFORM}/platform/slo/v1/slos/evaluation:start`, () =>
        HttpResponse.json({ ...evalResult, evaluationToken: evalToken }, { status: 202 }),
      ),
      // poll → 200 without evaluationToken (done)
      http.get(`${PLATFORM}/platform/slo/v1/slos/evaluation:poll`, () =>
        HttpResponse.json(evalResult, { status: 200 }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "evaluate_slo",
      arguments: { id: "SLO-2" },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SUCCESS");
    expect(text).toContain("98");
  });
});

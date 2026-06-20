import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAutomationTools } from "../../src/tools/automation.js";
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

const writeCfg: Config = { ...cfg, enableWrites: true };

const mswServer = setupServer(
  http.get(`${PLATFORM}/platform/automation/v1/workflows`, () =>
    HttpResponse.json({
      count: 1,
      results: [{ id: "wf-1", title: "Nightly cleanup" }],
    }),
  ),
);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

async function makeClient(config: Config = cfg) {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerAutomationTools(mcp, { client: new DynatraceClient(config), config });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

// ── list_workflows ────────────────────────────────────────────────────────────

describe("list_workflows", () => {
  it("returns workflow list containing the workflow title", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_workflows", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Nightly cleanup");
  });
});

// ── get_workflow_execution ────────────────────────────────────────────────────

describe("get_workflow_execution", () => {
  it("returns execution details including state", async () => {
    mswServer.use(
      http.get(`${PLATFORM}/platform/automation/v1/executions/EX-1`, () =>
        HttpResponse.json({ id: "EX-1", state: "SUCCESS" }),
      ),
    );

    const client = await makeClient();
    const res = await client.callTool({
      name: "get_workflow_execution",
      arguments: { id: "EX-1" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SUCCESS");
  });
});

// ── write-gate ────────────────────────────────────────────────────────────────

describe("create_workflow write-gate", () => {
  it("returns DT_ENABLE_WRITES error when writes are disabled", async () => {
    const client = await makeClient(cfg); // enableWrites: false
    const res = await client.callTool({
      name: "create_workflow",
      arguments: { workflow: { title: "x" } },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/DT_ENABLE_WRITES/);
  });
});

// ── create_workflow (success + passthrough) ───────────────────────────────────

describe("create_workflow — success + passthrough", () => {
  it("posts workflow body and preserves extra fields (passthrough proof)", async () => {
    let capturedBody: unknown = null;

    mswServer.use(
      http.post(`${PLATFORM}/platform/automation/v1/workflows`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: "wf-2" }, { status: 201 });
      }),
    );

    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "create_workflow",
      arguments: {
        workflow: {
          title: "Test workflow",
          description: "A test",
          tasks: { my_task: { action: "dynatrace.automations:http-function" } },
          // extra field — must be preserved by .passthrough()
          customLabel: "integration-test",
        },
      },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("wf-2");

    const posted = capturedBody as Record<string, unknown>;
    expect(posted.title).toBe("Test workflow");
    expect(posted.description).toBe("A test");
    // tasks nested record preserved
    expect(typeof posted.tasks).toBe("object");
    // extra field preserved by passthrough
    expect(posted.customLabel).toBe("integration-test");
  });
});

// ── run_workflow (success) ────────────────────────────────────────────────────

describe("run_workflow — success", () => {
  it("POSTs to /run and returns execution id", async () => {
    mswServer.use(
      http.post(`${PLATFORM}/platform/automation/v1/workflows/wf-2/run`, () =>
        HttpResponse.json({ id: "EX-9", state: "RUNNING" }, { status: 201 }),
      ),
    );

    const client = await makeClient(writeCfg);
    const res = await client.callTool({
      name: "run_workflow",
      arguments: { id: "wf-2", input: { key: "value" } },
    });

    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("EX-9");
  });
});

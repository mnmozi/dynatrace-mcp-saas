import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerVulnerabilitiesTools } from "../../src/tools/vulnerabilities.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const cfg: Config = {
  platformUrl: "https://plat.example.com",
  classicUrl: "https://classic.example.com",
  platformToken: "P",
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
};

const server = setupServer(
  http.get("https://plat.example.com/platform/vulnerabilities/v1/vulnerabilities", () =>
    HttpResponse.json({
      vulnerabilities: [
        {
          id: "V-1",
          displayId: "V-1",
          title: "Log4Shell",
          type: "CODE_LEVEL",
          stack: "CODE_LIBRARY",
          technology: "JAVA",
          description: "Critical Log4j vulnerability",
          references: { cve: ["CVE-2021-44228"], cwe: [], owasp: [] },
          resolution: { status: "OPEN" },
          risk: { score: 10.0, level: "CRITICAL" },
          davisAssessment: {
            score: 10.0,
            level: "CRITICAL",
            exposureStatus: "PUBLIC_NETWORK",
            dataAssetsStatus: "REACHABLE",
            assessmentMode: "FULL",
            exploitStatus: "AVAILABLE",
            vulnerableFunctionStatus: "IN_USE",
          },
          affectedEntities: {
            count: 3,
            types: ["PROCESS_GROUP"],
            processGroups: { count: 3 },
            kubernetesNodes: { count: 0 },
            hosts: { count: 0 },
            affectedProcesses: { count: 3 },
          },
          vulnerableComponents: [],
          isFixAvailable: true,
          mute: { status: "NOT_MUTED" },
          trackingLinkCoveragePercentage: 0,
        },
      ],
    }),
  ),
  http.get("https://plat.example.com/platform/vulnerabilities/v1/vulnerabilities/V-1", () =>
    HttpResponse.json({
      id: "V-1",
      displayId: "V-1",
      title: "Log4Shell",
      type: "CODE_LEVEL",
      stack: "CODE_LIBRARY",
      technology: "JAVA",
      description: "Critical Log4j vulnerability",
      references: { cve: ["CVE-2021-44228"], cwe: [], owasp: [] },
      resolution: { status: "OPEN" },
      risk: { score: 10.0, level: "CRITICAL" },
      davisAssessment: {
        score: 10.0,
        level: "CRITICAL",
        exposureStatus: "PUBLIC_NETWORK",
        dataAssetsStatus: "REACHABLE",
        assessmentMode: "FULL",
        exploitStatus: "AVAILABLE",
        vulnerableFunctionStatus: "IN_USE",
      },
      affectedEntities: {
        count: 3,
        types: ["PROCESS_GROUP"],
        processGroups: { count: 3 },
        kubernetesNodes: { count: 0 },
        hosts: { count: 0 },
        affectedProcesses: { count: 3 },
      },
      vulnerableComponents: [],
      isFixAvailable: true,
      mute: { status: "NOT_MUTED" },
      trackingLinkCoveragePercentage: 0,
    }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerVulnerabilitiesTools(mcp, { client: new DynatraceClient(cfg), config: cfg });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("list_vulnerabilities", () => {
  it("returns vulnerability list containing Log4Shell", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_vulnerabilities", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("Log4Shell");
  });
});

describe("get_vulnerability", () => {
  it("returns details of a single vulnerability", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "get_vulnerability", arguments: { id: "V-1" } });
    expect((res.content as Array<{ text: string }>)[0].text).toContain("Log4Shell");
  });
});

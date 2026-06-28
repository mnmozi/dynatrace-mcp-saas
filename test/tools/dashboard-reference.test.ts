import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDashboardReferenceTools } from "../../src/tools/dashboard-reference.js";

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerDashboardReferenceTools(mcp);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("dashboard_reference tool", () => {
  it("default topic (skill) returns content from dt-app-dashboards/SKILL.md", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "dashboard_reference", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    // SKILL.md contains "# Dynatrace Dashboard Skill"
    expect(text).toContain("Dynatrace Dashboard Skill");
  });

  it("topic 'tiles' returns content from tiles.md", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "dashboard_reference", arguments: { topic: "tiles" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    // tiles.md has "## Tile Types"
    expect(text).toContain("Tile Types");
  });

  it("topic 'example' returns valid JSON containing 'tiles'", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "dashboard_reference", arguments: { topic: "example" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("tiles");
  });

  it("topic 'notebooks' returns notebook skill content", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "dashboard_reference", arguments: { topic: "notebooks" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text.length).toBeGreaterThan(50);
    expect(text).not.toContain("Error: could not read");
  });
});

describe("list_dashboard_topics tool", () => {
  it("returns text containing 'tiles' and 'visualizations'", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_dashboard_topics", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("tiles");
    expect(text).toContain("visualizations");
  });

  it("lists all expected topics including notebooks", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_dashboard_topics", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("skill");
    expect(text).toContain("example");
    expect(text).toContain("notebooks");
  });
});

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerDqlReferenceTools } from "../../src/tools/dql-reference.js";

async function makeClient() {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerDqlReferenceTools(mcp);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

describe("dql_reference tool", () => {
  it("default topic (playbook) returns content from dql-skill.md", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "dql_reference", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    // dql-skill.md starts with "# DQL Skill — Agent Playbook for Dynatrace Grail"
    expect(text).toContain("DQL Skill");
  });

  it("topic 'gotchas' returns content from dql-filter-after-summarize-bug.md", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "dql_reference", arguments: { topic: "gotchas" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    // dql-filter-after-summarize-bug.md contains this distinctive heading
    expect(text).toContain("filter` Silently Dropped After `summarize`");
  });
});

describe("list_dql_topics tool", () => {
  it("returns text containing playbook and reference", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_dql_topics", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("playbook");
    expect(text).toContain("reference");
    expect(text).toContain("official");
  });
});

describe("vendored official dt-dql-essentials skill", () => {
  it("topic 'official' returns the official SKILL.md", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "dql_reference", arguments: { topic: "official" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("dt-dql-essentials");
  });

  it("list_dql_official_references lists the function-reference docs", async () => {
    const client = await makeClient();
    const res = await client.callTool({ name: "list_dql_official_references", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("dql/dql-functions-string.md");
  });

  it("officialRef fetches a specific reference doc", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "dql_reference",
      arguments: { officialRef: "dql/dql-functions-string.md" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text.length).toBeGreaterThan(50);
    expect(text).not.toContain("Error: could not read");
  });

  it("officialRef rejects path traversal", async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: "dql_reference",
      arguments: { officialRef: "../../../../../../etc/passwd" },
    });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("invalid officialRef path");
  });
});

/**
 * openpipeline_reference smoke test — each topic must return its real doc (not the
 * read-error fallback), and the docs must contain the content they advertise.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerOpenPipelineReferenceTools } from "../../src/tools/openpipeline-reference.js";

let client: Client;
beforeAll(async () => {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerOpenPipelineReferenceTools(mcp);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
});
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("openpipeline_reference", () => {
  it("default topic (authoring) returns the real doc", async () => {
    const body = text(await client.callTool({ name: "openpipeline_reference", arguments: {} }));
    expect(body).not.toMatch(/^Error: could not read/);
    expect(body).toMatch(/routing/i);
    expect(body).toMatch(/pipeline-groups/); // hyphenated schemaId gotcha present
    expect(body).toMatch(/primary-grail-tag/); // primary Grail tags section present
  });

  it("processors topic lists processor types and stages", async () => {
    const body = text(await client.callTool({ name: "openpipeline_reference", arguments: { topic: "processors" } }));
    expect(body).not.toMatch(/^Error: could not read/);
    expect(body).toMatch(/securityContext/);
    expect(body).toMatch(/bucketAssignment/);
    expect(body).toMatch(/metricExtraction/);
  });

  it("scripting topic covers the command subset and matcher functions", async () => {
    const body = text(await client.callTool({ name: "openpipeline_reference", arguments: { topic: "scripting" } }));
    expect(body).not.toMatch(/^Error: could not read/);
    expect(body).toMatch(/fieldsAdd/);
    expect(body).toMatch(/matchesPhrase/);
    expect(body).toMatch(/NOT available|not available/i); // the fetch/filter exclusion note
  });

  it("rejects an unknown topic via the input schema", async () => {
    const res = await client.callTool({ name: "openpipeline_reference", arguments: { topic: "nope" } });
    expect(res.isError).toBe(true);
  });
});

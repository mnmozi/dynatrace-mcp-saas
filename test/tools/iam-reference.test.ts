/**
 * iam_reference smoke test.
 *
 * The tool reads a bundled knowledge/*.md file at call time and silently returns an
 * "Error: could not read…" STRING if the file is missing/renamed (rather than throwing).
 * This test catches that silent break: the default topic must return the real doc, and
 * the doc must actually contain the IAM syntax it advertises.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIamReferenceTools } from "../../src/tools/iam-reference.js";

let client: Client;

beforeAll(async () => {
  const mcp = new McpServer({ name: "t", version: "0" });
  registerIamReferenceTools(mcp);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "c", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
});

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as Array<{ text: string }>)[0].text;

describe("iam_reference", () => {
  it("returns the real policies-and-boundaries doc by default (not the read-error fallback)", async () => {
    const res = await client.callTool({ name: "iam_reference", arguments: {} });
    const body = text(res);
    expect(body).not.toMatch(/^Error: could not read/);
    // The doc advertises this vocabulary — its presence proves we read the right file.
    expect(body).toMatch(/ALLOW/);
    expect(body).toMatch(/boundaryQuery|boundary/i);
    expect(body.length).toBeGreaterThan(200);
  });

  it("returns the account-api-operations doc for that topic", async () => {
    const res = await client.callTool({ name: "iam_reference", arguments: { topic: "account-api-operations" } });
    const body = text(res);
    expect(body).not.toMatch(/^Error: could not read/);
    // Proves we read the ops doc, not the syntax doc.
    expect(body).toMatch(/one-scope-per-token|one scope per token|invalid_request/i);
    expect(body).toMatch(/account-idm-read|account-uac-read/);
  });

  it("rejects an unknown topic via the input schema", async () => {
    const res = await client.callTool({ name: "iam_reference", arguments: { topic: "does-not-exist" } });
    expect(res.isError).toBe(true);
  });
});

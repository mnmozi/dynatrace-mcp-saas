import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveDocumentContent } from "../../src/util/document-content.js";

let dir: string;
let goodFile: string;
let badJsonFile: string;
let arrayFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "doc-content-"));
  goodFile = join(dir, "dashboard.json");
  writeFileSync(goodFile, JSON.stringify({ version: 21, tiles: { "0": { type: "markdown" } } }));
  badJsonFile = join(dir, "bad.json");
  writeFileSync(badJsonFile, "{ not valid json ");
  arrayFile = join(dir, "array.json");
  writeFileSync(arrayFile, JSON.stringify([1, 2, 3]));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveDocumentContent", () => {
  it("returns inline content unchanged when only content is given", async () => {
    const content = { version: 21, tiles: {} };
    await expect(resolveDocumentContent({ content })).resolves.toEqual(content);
  });

  it("reads and parses an absolute contentPath into an object", async () => {
    await expect(resolveDocumentContent({ contentPath: goodFile })).resolves.toEqual({
      version: 21,
      tiles: { "0": { type: "markdown" } },
    });
  });

  it("resolves a cwd-relative contentPath", async () => {
    const rel = relative(process.cwd(), goodFile);
    await expect(resolveDocumentContent({ contentPath: rel })).resolves.toEqual({
      version: 21,
      tiles: { "0": { type: "markdown" } },
    });
  });

  it("throws when both content and contentPath are provided", async () => {
    await expect(resolveDocumentContent({ content: { a: 1 }, contentPath: goodFile })).rejects.toThrow(
      /either content or contentPath, not both/i,
    );
  });

  it("throws when neither is provided and content is required", async () => {
    await expect(resolveDocumentContent({}, { required: true })).rejects.toThrow(/provide content .* or contentPath/i);
  });

  it("returns undefined when neither is provided and content is optional", async () => {
    await expect(resolveDocumentContent({})).resolves.toBeUndefined();
  });

  it("throws with the resolved path when the file does not exist", async () => {
    const missing = join(dir, "nope.json");
    await expect(resolveDocumentContent({ contentPath: missing })).rejects.toThrow(missing);
  });

  it("throws when the file is not valid JSON", async () => {
    await expect(resolveDocumentContent({ contentPath: badJsonFile })).rejects.toThrow(/must be a JSON object/i);
  });

  it("throws when the file JSON is not an object (e.g. an array)", async () => {
    await expect(resolveDocumentContent({ contentPath: arrayFile })).rejects.toThrow(/must be a JSON object/i);
  });
});

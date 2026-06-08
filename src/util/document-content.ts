import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/**
 * Resolves Document Service content from either an inline object (`content`)
 * or a path to a JSON file (`contentPath`). Exactly one of the two may be
 * supplied. Used by the dashboard/notebook create + update tools so large
 * documents can be written from a file instead of inlined.
 *
 *  - both supplied                  → throws (mutually exclusive)
 *  - contentPath supplied           → read UTF-8, JSON.parse, must be an object
 *  - content supplied               → returned unchanged
 *  - neither, opts.required = true  → throws (create needs content)
 *  - neither, opts.required falsy   → returns undefined (update may set name only)
 *
 * Relative `contentPath` values are resolved against `process.cwd()`.
 */
export async function resolveDocumentContent(
  input: { content?: Record<string, unknown>; contentPath?: string },
  opts: { required?: boolean } = {},
): Promise<Record<string, unknown> | undefined> {
  const { content, contentPath } = input;

  if (content !== undefined && contentPath !== undefined) {
    throw new Error("Provide either content or contentPath, not both.");
  }

  if (contentPath !== undefined) {
    const abs = isAbsolute(contentPath) ? contentPath : resolve(process.cwd(), contentPath);

    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      throw new Error(`contentPath not found: ${abs} (resolved from '${contentPath}').`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`contentPath must be a JSON object: ${msg}`);
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("contentPath must be a JSON object (got a non-object JSON value).");
    }

    return parsed as Record<string, unknown>;
  }

  if (content !== undefined) {
    return content;
  }

  if (opts.required) {
    throw new Error("Provide content (inline JSON) or contentPath (path to a JSON file).");
  }

  return undefined;
}

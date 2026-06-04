/** Set difference between two string arrays. */
export function diffStringSets(baseline: string[], current: string[]): { added: string[]; removed: string[] } {
  const b = new Set(baseline);
  const c = new Set(current);
  return {
    added: [...c].filter((x) => !b.has(x)).sort(),
    removed: [...b].filter((x) => !c.has(x)).sort(),
  };
}

/** Diff two maps of key -> version string. */
export function diffVersionMap(
  baseline: Record<string, string | undefined>,
  current: Record<string, string | undefined>,
): { added: string[]; removed: string[]; changed: Array<{ key: string; from: string | undefined; to: string | undefined }> } {
  const set = diffStringSets(Object.keys(baseline), Object.keys(current));
  const changed: Array<{ key: string; from: string | undefined; to: string | undefined }> = [];
  for (const key of Object.keys(current)) {
    if (key in baseline && baseline[key] !== current[key]) {
      changed.push({ key, from: baseline[key], to: current[key] });
    }
  }
  changed.sort((x, y) => x.key.localeCompare(y.key));
  return { added: set.added, removed: set.removed, changed };
}

/** Extract operation keys "METHOD /path" from a parsed OpenAPI document. */
export function extractOperations(openapi: { paths?: Record<string, unknown> } | null | undefined): string[] {
  const out: string[] = [];
  const paths = openapi?.paths ?? {};
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of ["get", "post", "put", "delete", "patch", "head", "options"]) {
      if (method in (item as Record<string, unknown>)) out.push(`${method.toUpperCase()} ${p}`);
    }
  }
  return out.sort();
}

/** Diff the operation sets of two parsed OpenAPI documents. */
export function diffOperations(
  baseline: { paths?: Record<string, unknown> } | null | undefined,
  current: { paths?: Record<string, unknown> } | null | undefined,
): { added: string[]; removed: string[] } {
  return diffStringSets(extractOperations(baseline), extractOperations(current));
}

/** Recursively collect leaf+object key paths of an object (dot/bracket notation), for structural diffing. */
export function objectKeyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return prefix ? [prefix] : [];
  const out: string[] = [];
  if (Array.isArray(obj)) {
    // represent arrays by a single [] path plus the union of child paths (index-agnostic)
    if (obj.length === 0 && prefix) out.push(`${prefix}[]`);
    for (const el of obj) out.push(...objectKeyPaths(el, `${prefix}[]`));
  } else {
    const keys = Object.keys(obj as Record<string, unknown>);
    if (keys.length === 0 && prefix) out.push(prefix);
    for (const k of keys) {
      const path = prefix ? `${prefix}.${k}` : k;
      const val = (obj as Record<string, unknown>)[k];
      if (val !== null && typeof val === "object") out.push(...objectKeyPaths(val, path));
      else out.push(path);
    }
  }
  return Array.from(new Set(out)).sort();
}

/** Diff two objects by their key paths (added/removed paths). Useful for schema structural drift. */
export function diffObjectKeyPaths(baseline: unknown, current: unknown): { added: string[]; removed: string[] } {
  return diffStringSets(objectKeyPaths(baseline), objectKeyPaths(current));
}

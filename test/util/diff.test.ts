import { describe, it, expect } from "vitest";
import {
  diffStringSets,
  diffVersionMap,
  extractOperations,
  diffOperations,
  objectKeyPaths,
  diffObjectKeyPaths,
} from "../../src/util/diff.js";

describe("diffStringSets", () => {
  it("returns added and removed elements sorted", () => {
    expect(diffStringSets(["a", "b"], ["b", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
    });
  });

  it("returns empty arrays when sets are identical", () => {
    expect(diffStringSets(["x", "y"], ["x", "y"])).toEqual({
      added: [],
      removed: [],
    });
  });

  it("handles empty baseline (everything is added)", () => {
    expect(diffStringSets([], ["a", "b"])).toEqual({
      added: ["a", "b"],
      removed: [],
    });
  });

  it("handles empty current (everything is removed)", () => {
    expect(diffStringSets(["a", "b"], [])).toEqual({
      added: [],
      removed: ["a", "b"],
    });
  });

  it("deduplicates duplicates in input arrays", () => {
    expect(diffStringSets(["a", "a"], ["a", "b"])).toEqual({
      added: ["b"],
      removed: [],
    });
  });
});

describe("diffVersionMap", () => {
  it("detects added, removed, and changed keys", () => {
    const result = diffVersionMap({ x: "1", y: "1" }, { y: "2", z: "1" });
    expect(result.added).toEqual(["z"]);
    expect(result.removed).toEqual(["x"]);
    expect(result.changed).toEqual([{ key: "y", from: "1", to: "2" }]);
  });

  it("returns empty arrays when maps are identical", () => {
    const result = diffVersionMap({ a: "1" }, { a: "1" });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual([]);
  });

  it("sorts changed entries by key", () => {
    const result = diffVersionMap({ b: "1", a: "1" }, { b: "2", a: "2" });
    expect(result.changed.map((c) => c.key)).toEqual(["a", "b"]);
  });

  it("handles undefined version values", () => {
    const result = diffVersionMap({ a: undefined }, { a: "1" });
    expect(result.changed).toEqual([{ key: "a", from: undefined, to: "1" }]);
  });
});

describe("extractOperations", () => {
  it("extracts and sorts HTTP method + path operations", () => {
    const spec = {
      paths: {
        "/a": { get: {}, post: {} },
        "/b": { delete: {} },
      },
    };
    expect(extractOperations(spec)).toEqual(["DELETE /b", "GET /a", "POST /a"]);
  });

  it("returns empty array for null input", () => {
    expect(extractOperations(null)).toEqual([]);
  });

  it("returns empty array for undefined input", () => {
    expect(extractOperations(undefined)).toEqual([]);
  });

  it("returns empty array for spec with no paths", () => {
    expect(extractOperations({})).toEqual([]);
  });

  it("handles all supported HTTP methods", () => {
    const spec = {
      paths: {
        "/r": { get: {}, post: {}, put: {}, delete: {}, patch: {}, head: {}, options: {} },
      },
    };
    const ops = extractOperations(spec);
    expect(ops).toContain("GET /r");
    expect(ops).toContain("POST /r");
    expect(ops).toContain("PUT /r");
    expect(ops).toContain("DELETE /r");
    expect(ops).toContain("PATCH /r");
    expect(ops).toContain("HEAD /r");
    expect(ops).toContain("OPTIONS /r");
    expect(ops).toHaveLength(7);
  });
});

describe("diffOperations", () => {
  const specA = {
    paths: {
      "/users": { get: {}, post: {} },
      "/users/{id}": { delete: {} },
    },
  };
  const specB = {
    paths: {
      "/users": { get: {} },
      "/users/{id}": { get: {}, put: {} },
    },
  };

  it("detects added and removed operations between two specs", () => {
    const result = diffOperations(specA, specB);
    expect(result.added).toEqual(["GET /users/{id}", "PUT /users/{id}"]);
    expect(result.removed).toEqual(["DELETE /users/{id}", "POST /users"]);
  });

  it("returns empty diffs for identical specs", () => {
    const result = diffOperations(specA, specA);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("handles null/undefined inputs gracefully", () => {
    const result = diffOperations(null, specA);
    expect(result.added).toEqual(["DELETE /users/{id}", "GET /users", "POST /users"]);
    expect(result.removed).toEqual([]);
  });
});

describe("objectKeyPaths", () => {
  it("includes nested key paths with dot notation", () => {
    const paths = objectKeyPaths({ a: { b: 1 }, c: [{ d: 2 }] });
    expect(paths).toContain("a.b");
    expect(paths).toContain("c[].d");
  });

  it("returns flat keys for a flat object", () => {
    expect(objectKeyPaths({ x: 1, y: 2 })).toEqual(["x", "y"]);
  });

  it("returns a single path for a primitive with prefix", () => {
    expect(objectKeyPaths(42, "root")).toEqual(["root"]);
  });

  it("returns empty array for null", () => {
    expect(objectKeyPaths(null)).toEqual([]);
  });

  it("handles empty object", () => {
    expect(objectKeyPaths({})).toEqual([]);
  });

  it("handles empty array with prefix", () => {
    const paths = objectKeyPaths([], "items");
    expect(paths).toContain("items[]");
  });

  it("deduplicates paths from multiple array elements", () => {
    // Two elements both having key "id" should produce one path, not two
    const paths = objectKeyPaths([{ id: 1 }, { id: 2 }]);
    // key path is "[]id" or "[].id" depending on interpretation — we check the actual shape
    expect(paths.filter((p) => p.includes("id"))).toHaveLength(1);
  });

  it("handles deeply nested structures", () => {
    const paths = objectKeyPaths({ a: { b: { c: 42 } } });
    expect(paths).toEqual(["a.b.c"]);
  });
});

describe("diffObjectKeyPaths", () => {
  it("detects added and removed key paths", () => {
    const result = diffObjectKeyPaths({ a: { b: 1 } }, { a: { b: 1, e: 2 } });
    expect(result.added).toEqual(["a.e"]);
    expect(result.removed).toEqual([]);
  });

  it("detects removed paths", () => {
    const result = diffObjectKeyPaths({ a: 1, b: 2 }, { a: 1 });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(["b"]);
  });

  it("returns empty diffs for identical objects", () => {
    const result = diffObjectKeyPaths({ x: { y: 1 } }, { x: { y: 1 } });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("handles null inputs", () => {
    const result = diffObjectKeyPaths(null, { a: 1 });
    expect(result.added).toEqual(["a"]);
    expect(result.removed).toEqual([]);
  });
});

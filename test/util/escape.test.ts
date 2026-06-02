import { describe, it, expect } from "vitest";
import { escapeQuotes } from "../../src/util/escape.js";

describe("escapeQuotes", () => {
  it('escapes a double-quote inside a string', () => {
    expect(escapeQuotes('a"b')).toBe('a\\"b');
  });

  it('escapes multiple double-quotes', () => {
    expect(escapeQuotes('"hello"')).toBe('\\"hello\\"');
  });

  it('leaves strings without double-quotes unchanged', () => {
    expect(escapeQuotes("env:prod")).toBe("env:prod");
  });

  it('handles an empty string', () => {
    expect(escapeQuotes("")).toBe("");
  });
});

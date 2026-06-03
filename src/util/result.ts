export function jsonResult(data: unknown) {
  // Empty/204 responses (e.g. DELETE) yield `undefined`, and JSON.stringify(undefined)
  // returns the value `undefined` (not a string), which is an invalid MCP tool result.
  // Coerce to a valid success payload so every tool returns a string.
  const text = data === undefined ? JSON.stringify({ success: true }, null, 2) : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}
export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Escape embedded double-quotes so a value can be safely placed inside a "..." literal in DQL or an entitySelector. */
export function escapeQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

/** The one matching rule behind every tool-side `query` filter: a case-insensitive substring. */
export function containsIgnoreCase(text: string, fragment: string): boolean {
  return text.toLowerCase().includes(fragment.toLowerCase());
}

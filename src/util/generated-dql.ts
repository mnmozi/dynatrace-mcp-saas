import type { DynatraceClient } from "../http/client.js";
import type { DqlResult } from "../http/dql.js";

/**
 * Run a DQL query that a tool built from its own arguments. The caller never saw that query,
 * so Grail's "line 1, col 58" would point at nothing: on failure the query is appended.
 */
export async function runGeneratedDql(
  client: DynatraceClient,
  query: string,
  maxResultRecords: number,
): Promise<DqlResult> {
  try {
    return await client.dqlExecute(query, { maxResultRecords });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${message}\nGenerated DQL: ${query}`, { cause });
  }
}

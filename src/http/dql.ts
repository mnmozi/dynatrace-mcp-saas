import type { HostClient } from "../types.js";
import { extractDqlErrorDetail, formatDqlErrorSuffix } from "./errors.js";

export interface DqlResult {
  records: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

interface ExecuteResponse { state: string; requestToken?: string; result?: RawResult }
interface PollResponse { state: string; result?: RawResult; progress?: number }
interface RawResult { records?: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }

const BASE = "/platform/storage/query/v1";

export async function dqlExecute(
  platform: HostClient,
  query: string,
  opts: { maxResultRecords?: number; pollIntervalMs?: number; maxPolls?: number } = {},
): Promise<DqlResult> {
  const { maxResultRecords = 1000, pollIntervalMs = 500, maxPolls = 120 } = opts;
  const start = await platform.post<ExecuteResponse>(`${BASE}/query:execute`, {
    query,
    maxResultRecords,
    requestTimeoutMilliseconds: 60000,
    fetchTimeoutSeconds: 60,
  });

  if (start.state === "SUCCEEDED" && start.result) return normalize(start.result);
  const token = start.requestToken;
  if (!token) throw new Error("DQL execute returned no requestToken and was not SUCCEEDED");

  for (let i = 0; i < maxPolls; i++) {
    const poll = await platform.get<PollResponse>(`${BASE}/query:poll`, { "request-token": token });
    if (poll.state === "SUCCEEDED") return normalize(poll.result);
    if (poll.state === "FAILED" || poll.state === "CANCELLED") {
      const suffix = formatDqlErrorSuffix(extractDqlErrorDetail(poll));
      throw new Error(`DQL query ${poll.state}${suffix || `: ${JSON.stringify(poll)}`}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`DQL query did not complete after ${maxPolls} polls`);
}

function normalize(result?: RawResult): DqlResult {
  return { records: result?.records ?? [], metadata: result?.metadata };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

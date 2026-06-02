import type { Config } from "../types.js";
import { DynatraceApiError, type HostKind, type QueryParams } from "./errors.js";
import type { HostClient } from "../types.js";
import { dqlExecute, type DqlResult } from "./dql.js";

function buildUrl(base: string, path: string, query?: QueryParams): string {
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

class HostClientImpl implements HostClient {
  constructor(
    private readonly base: string,
    private readonly authHeader: string,
    private readonly host: HostKind,
    private readonly timeoutMs: number,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, query?: QueryParams): Promise<T> {
    const url = buildUrl(this.base, path, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = text ? safeJson(text) : undefined;
      if (!res.ok) {
        throw new DynatraceApiError(res.status, this.host, parsed ?? text, path);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string, query?: QueryParams) { return this.request<T>("GET", path, undefined, query); }
  post<T>(path: string, body?: unknown, query?: QueryParams) { return this.request<T>("POST", path, body, query); }
  put<T>(path: string, body?: unknown, query?: QueryParams) { return this.request<T>("PUT", path, body, query); }
  del<T>(path: string, query?: QueryParams) { return this.request<T>("DELETE", path, undefined, query); }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export class DynatraceClient {
  readonly classic: HostClient;
  readonly platform: HostClient;

  constructor(private readonly cfg: Config) {
    this.classic = new HostClientImpl(cfg.classicUrl, `Api-Token ${cfg.apiToken}`, "classic", cfg.timeoutMs);
    this.platform = new HostClientImpl(cfg.platformUrl, `Bearer ${cfg.platformToken}`, "platform", cfg.timeoutMs);
  }

  dqlExecute(query: string, opts?: { maxResultRecords?: number; pollIntervalMs?: number; maxPolls?: number }): Promise<DqlResult> {
    return dqlExecute(this.platform, query, opts);
  }
}

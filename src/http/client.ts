import type { Config } from "../types.js";
import { DynatraceApiError, type HostKind, type QueryParams } from "./errors.js";
import type { HostClient } from "../types.js";
import { dqlExecute, type DqlResult } from "./dql.js";
import { AccountClient } from "./account.js";

function buildUrl(base: string, path: string, query?: QueryParams): string {
  const url = new URL(base + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

/** Statuses that should trigger a retry. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Parse a Retry-After header value.
 * Returns the number of milliseconds to wait, capped at 30 000 ms.
 * Returns null if the header is absent or unparseable.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Integer seconds?
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && /^\d+$/.test(trimmed)) {
    return Math.min(seconds * 1000, 30_000);
  }
  // HTTP-date?
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const waitMs = dateMs - Date.now();
    return Math.min(Math.max(waitMs, 0), 30_000);
  }
  return null;
}

/** Exponential backoff with jitter, capped at 10 s. */
function backoffMs(baseMs: number, attemptIndex: number): number {
  const exponential = baseMs * Math.pow(2, attemptIndex);
  const jitter = Math.random() * 100;
  return Math.min(exponential + jitter, 10_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HostClientImpl implements HostClient {
  constructor(
    private readonly base: string,
    private readonly authHeader: string,
    private readonly host: HostKind,
    private readonly timeoutMs: number,
    private readonly maxRetries: number,
    private readonly retryBaseMs: number,
  ) {}

  /**
   * Execute a single fetch attempt with its own AbortController timeout.
   * Returns the raw Response — the caller decides whether to retry.
   */
  private async attempt(fetchFn: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetchFn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Shared retry routine. Calls `attemptFn` up to `maxRetries + 1` times.
   * Retries on: 429, 408, >=500, or network errors.
   * On 429 honours Retry-After (capped at 30 s); otherwise uses exponential backoff.
   * Non-retryable responses (other 4xx, 2xx, 3xx) are returned immediately.
   * After exhausting retries, returns the last Response or rethrows the last error.
   */
  private async withRetry(fetchFn: (signal: AbortSignal) => Promise<Response>): Promise<Response> {
    let lastError: unknown = undefined;
    let lastResponse: Response | undefined = undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.attempt(fetchFn);
        if (!isRetryableStatus(res.status)) {
          // Success or non-retryable client error — return immediately.
          return res;
        }
        lastResponse = res;
        if (attempt < this.maxRetries) {
          // Determine wait time.
          let waitMs: number;
          if (res.status === 429) {
            const fromHeader = parseRetryAfterMs(res.headers.get("Retry-After"));
            waitMs = fromHeader !== null ? fromHeader : backoffMs(this.retryBaseMs, attempt);
          } else {
            waitMs = backoffMs(this.retryBaseMs, attempt);
          }
          await sleep(waitMs);
        }
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(this.retryBaseMs, attempt));
        }
      }
    }

    if (lastResponse !== undefined) {
      return lastResponse;
    }
    throw lastError;
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: QueryParams): Promise<T> {
    const url = buildUrl(this.base, path, query);
    // Serialize body once so it can be reused across retries.
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    const res = await this.withRetry((signal) => fetch(url, { method, headers, body: serializedBody, signal }));

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new DynatraceApiError(res.status, this.host, parsed ?? text, path);
    }
    return parsed as T;
  }

  private async requestForm<T>(method: string, path: string, form: FormData, query?: QueryParams): Promise<T> {
    const url = buildUrl(this.base, path, query);
    // Do NOT set Content-Type — let fetch set it with the multipart boundary.
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };

    const res = await this.withRetry((signal) => fetch(url, { method, headers, body: form, signal }));

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new DynatraceApiError(res.status, this.host, parsed ?? text, path);
    }
    return parsed as T;
  }

  private async requestText(path: string, query?: QueryParams): Promise<string> {
    const url = buildUrl(this.base, path, query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
    };

    const res = await this.withRetry((signal) => fetch(url, { method: "GET", headers, signal }));

    const text = await res.text();
    if (!res.ok) {
      const parsed = text ? safeJson(text) : undefined;
      throw new DynatraceApiError(res.status, this.host, parsed ?? text, path);
    }
    return text;
  }

  get<T>(path: string, query?: QueryParams) {
    return this.request<T>("GET", path, undefined, query);
  }
  post<T>(path: string, body?: unknown, query?: QueryParams) {
    return this.request<T>("POST", path, body, query);
  }
  put<T>(path: string, body?: unknown, query?: QueryParams) {
    return this.request<T>("PUT", path, body, query);
  }
  del<T>(path: string, query?: QueryParams) {
    return this.request<T>("DELETE", path, undefined, query);
  }
  postForm<T>(path: string, form: FormData, query?: QueryParams) {
    return this.requestForm<T>("POST", path, form, query);
  }
  patchForm<T>(path: string, form: FormData, query?: QueryParams) {
    return this.requestForm<T>("PATCH", path, form, query);
  }
  getText(path: string, query?: QueryParams) {
    return this.requestText(path, query);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Returns a stub HostClient whose every method rejects with a clear, actionable error
 * explaining which env vars to set in order to enable the absent host.
 */
function unconfiguredHost(hostKind: "classic" | "platform", envVars: string): HostClient {
  const fail = async (): Promise<never> => {
    throw new Error(
      `The ${hostKind} Dynatrace API is not configured on this server. Set ${envVars} to enable this tool.`,
    );
  };
  return {
    get: fail,
    post: fail,
    put: fail,
    del: fail,
    postForm: fail,
    patchForm: fail,
    getText: fail,
  } as unknown as HostClient;
}

export class DynatraceClient {
  readonly classic: HostClient;
  readonly platform: HostClient;
  /** Account Management API client (OAuth client-credentials); null when not configured. */
  readonly account: AccountClient | null;
  /**
   * Platform-host client for IAM tools. Uses the dedicated DT_IAM_TOKEN when set
   * (a token carrying iam:* scopes), otherwise falls back to the regular platform
   * client — so IAM tools work either way, with whatever scopes that token has.
   */
  readonly iam: HostClient;

  constructor(private readonly cfg: Config) {
    const maxRetries = cfg.maxRetries ?? 3;
    const retryBaseMs = cfg.retryBaseMs ?? 500;

    this.classic =
      cfg.classicUrl && cfg.apiToken
        ? new HostClientImpl(
            cfg.classicUrl,
            `Api-Token ${cfg.apiToken}`,
            "classic",
            cfg.timeoutMs,
            maxRetries,
            retryBaseMs,
          )
        : unconfiguredHost("classic", "DT_CLASSIC_URL + DT_API_TOKEN");

    this.platform =
      cfg.platformUrl && cfg.platformToken
        ? new HostClientImpl(
            cfg.platformUrl,
            `Bearer ${cfg.platformToken}`,
            "platform",
            cfg.timeoutMs,
            maxRetries,
            retryBaseMs,
          )
        : unconfiguredHost("platform", "DT_PLATFORM_URL + DT_PLATFORM_TOKEN");

    this.account = cfg.oauthClientId && cfg.oauthClientSecret && cfg.accountUrn ? new AccountClient(cfg) : null;

    this.iam =
      cfg.platformUrl && cfg.iamToken
        ? new HostClientImpl(
            cfg.platformUrl,
            `Bearer ${cfg.iamToken}`,
            "platform",
            cfg.timeoutMs,
            maxRetries,
            retryBaseMs,
          )
        : this.platform;
  }

  /** The account client, or a clear error when the OAuth trio is not configured. */
  requireAccount(): AccountClient {
    if (!this.account) {
      throw new Error(
        "The Dynatrace Account Management API is not configured on this server. " +
          "Set DT_OAUTH_CLIENT_ID, DT_OAUTH_CLIENT_SECRET and DT_ACCOUNT_URN (urn:dtaccount:<uuid>) to enable this tool.",
      );
    }
    return this.account;
  }

  dqlExecute(
    query: string,
    opts?: { maxResultRecords?: number; pollIntervalMs?: number; maxPolls?: number },
  ): Promise<DqlResult> {
    return dqlExecute(this.platform, query, opts);
  }
}

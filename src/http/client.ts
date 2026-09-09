import type { Config } from "../types.js";
import { DynatraceApiError, type HostKind, type QueryParams } from "./errors.js";
import type { HostClient } from "../types.js";
import { dqlExecute, type DqlResult } from "./dql.js";
import { AccountClient } from "./account.js";
import { runWithRetry, type RequestOpts, type RetryEngineConfig, type RetryOutcome } from "./retry.js";

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


class HostClientImpl implements HostClient {
  constructor(
    private readonly base: string,
    private readonly authHeader: string,
    private readonly host: HostKind,
    private readonly timeoutMs: number,
    private readonly maxRetries: number,
    private readonly retryBaseMs: number,
  ) {}

  private engineCfg(): RetryEngineConfig {
    return { maxRetries: this.maxRetries, baseMs: this.retryBaseMs, timeoutMs: this.timeoutMs };
  }

  /** Turn a retry outcome into the parsed body (or the verifier-supplied value). */
  private async finishJson<T>(outcome: RetryOutcome, path: string): Promise<T> {
    if (outcome.kind === "verified") return outcome.value as T;
    const res = outcome.response;
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) throw new DynatraceApiError(res.status, this.host, parsed ?? text, path);
    return parsed as T;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: QueryParams,
    opts?: RequestOpts,
  ): Promise<T> {
    const url = buildUrl(this.base, path, query);
    // Serialize body once so it can be reused across retries.
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": opts?.contentType ?? "application/json",
      Accept: "application/json",
    };
    const outcome = await runWithRetry(
      (signal) => fetch(url, { method, headers, body: serializedBody, signal }),
      this.engineCfg(),
      method,
      opts,
    );
    return this.finishJson<T>(outcome, path);
  }

  private async requestForm<T>(
    method: string,
    path: string,
    form: FormData,
    query?: QueryParams,
    opts?: RequestOpts,
  ): Promise<T> {
    const url = buildUrl(this.base, path, query);
    // Do NOT set Content-Type — let fetch set it with the multipart boundary.
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    const outcome = await runWithRetry(
      (signal) => fetch(url, { method, headers, body: form, signal }),
      this.engineCfg(),
      method,
      opts,
    );
    return this.finishJson<T>(outcome, path);
  }

  private async requestText(path: string, query?: QueryParams): Promise<string> {
    const url = buildUrl(this.base, path, query);
    const headers: Record<string, string> = { Authorization: this.authHeader };
    const outcome = await runWithRetry(
      (signal) => fetch(url, { method: "GET", headers, signal }),
      this.engineCfg(),
      "GET",
    );
    if (outcome.kind === "verified") return String(outcome.value);
    const res = outcome.response;
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
  post<T>(path: string, body?: unknown, query?: QueryParams, opts?: RequestOpts) {
    return this.request<T>("POST", path, body, query, opts);
  }
  put<T>(path: string, body?: unknown, query?: QueryParams, opts?: RequestOpts) {
    return this.request<T>("PUT", path, body, query, opts);
  }
  del<T>(path: string, query?: QueryParams, opts?: RequestOpts) {
    return this.request<T>("DELETE", path, undefined, query, opts);
  }
  postForm<T>(path: string, form: FormData, query?: QueryParams, opts?: RequestOpts) {
    return this.requestForm<T>("POST", path, form, query, opts);
  }
  patchForm<T>(path: string, form: FormData, query?: QueryParams, opts?: RequestOpts) {
    return this.requestForm<T>("PATCH", path, form, query, opts);
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

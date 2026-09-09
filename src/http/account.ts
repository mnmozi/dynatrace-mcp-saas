import type { Config, QueryParams } from "../types.js";
import { DynatraceApiError } from "./errors.js";
import { runWithRetry, type RequestOpts, type RetryEngineConfig } from "./retry.js";

/**
 * Client for the Dynatrace Account Management API (api.dynatrace.com).
 *
 * Uses the OAuth2 client-credentials flow against the Dynatrace SSO token
 * endpoint — a third credential type distinct from the platform (dt0s16) and
 * classic (dt0c01) tokens. Tokens are cached until shortly before expiry.
 */
export class AccountClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly accountUrn: string;
  private readonly tokenUrl: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly defaultScope: string;

  /** One cached token per scope — different account APIs require different scopes. */
  private readonly tokenCache = new Map<string, { value: string; expiresAt: number }>();

  constructor(cfg: Config) {
    if (!cfg.oauthClientId || !cfg.oauthClientSecret || !cfg.accountUrn) {
      throw new Error("AccountClient requires oauthClientId, oauthClientSecret and accountUrn.");
    }
    this.clientId = cfg.oauthClientId;
    this.clientSecret = cfg.oauthClientSecret;
    this.accountUrn = cfg.accountUrn;
    this.tokenUrl = cfg.ssoTokenUrl ?? "https://sso.dynatrace.com/sso/oauth2/token";
    this.base = cfg.accountApiUrl ?? "https://api.dynatrace.com";
    this.timeoutMs = cfg.timeoutMs;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.retryBaseMs = cfg.retryBaseMs ?? 500;
    this.defaultScope = cfg.oauthScope ?? "iam-policies-management";
  }

  private engineCfg(): RetryEngineConfig {
    return { maxRetries: this.maxRetries, baseMs: this.retryBaseMs, timeoutMs: this.timeoutMs };
  }

  /** The account UUID derived from the URN (urn:dtaccount:<uuid>). */
  get accountUuid(): string {
    return this.accountUrn.replace(/^urn:dtaccount:/, "");
  }

  private async getToken(scope: string): Promise<string> {
    const cached = this.tokenCache.get(scope);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }

    // NOTE: request a SINGLE scope — the SSO rejects multi-scope client-credentials
    // requests for these clients with 400 invalid_request (live-verified). Different
    // account APIs need different scopes (iam-policies-management for the repo API;
    // account-idm-read/write for group/user management), so tokens are cached per scope.
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope,
      resource: this.accountUrn,
    });

    const serialized = body.toString();
    // The token request is effectively idempotent (re-requesting just mints another
    // token) — route it through the shared engine so it gets retry + wrapped timeouts.
    const outcome = await runWithRetry(
      (signal) =>
        fetch(this.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: serialized,
          signal,
        }),
      this.engineCfg(),
      "POST",
      { retryClass: "idempotent" },
    );
    // getToken never supplies a verifier, so the outcome is always a Response here.
    const res = outcome.kind === "response" ? outcome.response : undefined;
    if (!res) throw new Error("SSO token request returned no response.");

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new DynatraceApiError(res.status, "account", parsed, `(sso token endpoint, scope="${scope}")`);
    }

    const tok = parsed as { access_token?: string; expires_in?: number };
    if (!tok.access_token) {
      throw new Error("SSO token endpoint returned no access_token.");
    }
    // Refresh 60s before actual expiry.
    const ttlMs = Math.max(((tok.expires_in ?? 300) - 60) * 1000, 30_000);
    this.tokenCache.set(scope, { value: tok.access_token, expiresAt: Date.now() + ttlMs });
    return tok.access_token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: QueryParams,
    scope?: string,
    opts?: RequestOpts,
  ): Promise<T> {
    const token = await this.getToken(scope ?? this.defaultScope);
    const url = new URL(this.base + path);
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

    // Serialize once so the body can be reused across retries.
    const serialized = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    const outcome = await runWithRetry(
      (signal) => fetch(url.toString(), { method, headers, body: serialized, signal }),
      this.engineCfg(),
      method,
      opts,
    );
    if (outcome.kind === "verified") return outcome.value as T;

    const res = outcome.response;
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new DynatraceApiError(res.status, "account", parsed ?? text, path);
    }
    return (parsed ?? { success: true }) as T;
  }

  get<T = unknown>(path: string, query?: QueryParams, scope?: string): Promise<T> {
    return this.request<T>("GET", path, undefined, query, scope);
  }
  post<T = unknown>(path: string, body?: unknown, query?: QueryParams, scope?: string, opts?: RequestOpts): Promise<T> {
    return this.request<T>("POST", path, body, query, scope, opts);
  }
  put<T = unknown>(path: string, body?: unknown, query?: QueryParams, scope?: string, opts?: RequestOpts): Promise<T> {
    return this.request<T>("PUT", path, body, query, scope, opts);
  }
  del<T = unknown>(path: string, query?: QueryParams, scope?: string, opts?: RequestOpts): Promise<T> {
    return this.request<T>("DELETE", path, undefined, query, scope, opts);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

import type { Config, QueryParams } from "../types.js";
import { DynatraceApiError } from "./errors.js";

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

  private cachedToken: { value: string; expiresAt: number } | null = null;

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
  }

  /** The account UUID derived from the URN (urn:dtaccount:<uuid>). */
  get accountUuid(): string {
    return this.accountUrn.replace(/^urn:dtaccount:/, "");
  }

  private async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.value;
    }

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "account-idm-read account-idm-write iam-policies-management iam:boundaries:read iam:boundaries:write",
      resource: this.accountUrn,
    });

    const res = await fetch(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      throw new DynatraceApiError(res.status, "account", parsed, "(sso token endpoint)");
    }

    const tok = parsed as { access_token?: string; expires_in?: number };
    if (!tok.access_token) {
      throw new Error("SSO token endpoint returned no access_token.");
    }
    // Refresh 60s before actual expiry.
    const ttlMs = Math.max(((tok.expires_in ?? 300) - 60) * 1000, 30_000);
    this.cachedToken = { value: tok.access_token, expiresAt: Date.now() + ttlMs };
    return tok.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: QueryParams): Promise<T> {
    const token = await this.getToken();
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

    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new DynatraceApiError(res.status, "account", parsed ?? text, path);
    }
    return (parsed ?? { success: true }) as T;
  }

  get<T = unknown>(path: string, query?: QueryParams): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }
  post<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
    return this.request<T>("POST", path, body, query);
  }
  put<T = unknown>(path: string, body?: unknown, query?: QueryParams): Promise<T> {
    return this.request<T>("PUT", path, body, query);
  }
  del<T = unknown>(path: string, query?: QueryParams): Promise<T> {
    return this.request<T>("DELETE", path, undefined, query);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

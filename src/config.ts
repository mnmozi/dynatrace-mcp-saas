import type { Config } from "./types.js";

export type { Config } from "./types.js";

type Env = Record<string, string | undefined>;

const stripSlash = (u: string) => u.replace(/\/+$/, "");

function optional(env: Env, key: string): string | undefined {
  const v = env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function loadConfig(env: Env = process.env): Config {
  const platformUrl = optional(env, "DT_PLATFORM_URL");
  const platformToken = optional(env, "DT_PLATFORM_TOKEN");
  const classicUrl = optional(env, "DT_CLASSIC_URL");
  const apiToken = optional(env, "DT_API_TOKEN");

  // Check for half-set pairs — one present without the other.
  if (platformUrl && !platformToken) {
    throw new Error("DT_PLATFORM_URL is set but DT_PLATFORM_TOKEN is missing (provide both or neither).");
  }
  if (platformToken && !platformUrl) {
    throw new Error("DT_PLATFORM_TOKEN is set but DT_PLATFORM_URL is missing (provide both or neither).");
  }
  if (classicUrl && !apiToken) {
    throw new Error("DT_CLASSIC_URL is set but DT_API_TOKEN is missing (provide both or neither).");
  }
  if (apiToken && !classicUrl) {
    throw new Error("DT_API_TOKEN is set but DT_CLASSIC_URL is missing (provide both or neither).");
  }

  // Optional dedicated IAM platform token (iam:* scopes). Needs the platform host.
  const iamToken = optional(env, "DT_IAM_TOKEN");
  if (iamToken && !platformUrl) {
    throw new Error("DT_IAM_TOKEN is set but DT_PLATFORM_URL is missing — the IAM token targets the platform host.");
  }

  // Account Management API OAuth client (optional) — all three or none.
  const oauthClientId = optional(env, "DT_OAUTH_CLIENT_ID");
  const oauthClientSecret = optional(env, "DT_OAUTH_CLIENT_SECRET");
  const accountUrn = optional(env, "DT_ACCOUNT_URN");
  const oauthSet = [oauthClientId, oauthClientSecret, accountUrn].filter(Boolean).length;
  if (oauthSet > 0 && oauthSet < 3) {
    throw new Error(
      "Partial account OAuth config: set ALL of DT_OAUTH_CLIENT_ID, DT_OAUTH_CLIENT_SECRET and DT_ACCOUNT_URN, or none.",
    );
  }

  const hasPlatform = !!(platformUrl && platformToken);
  const hasClassic = !!(classicUrl && apiToken);

  if (!hasPlatform && !hasClassic) {
    throw new Error(
      "No Dynatrace credentials configured. Provide at least one pair: " +
        "(DT_PLATFORM_URL + DT_PLATFORM_TOKEN) for platform/Grail tools, and/or " +
        "(DT_CLASSIC_URL + DT_API_TOKEN) for classic /api/v2 tools.",
    );
  }

  return {
    platformUrl: platformUrl ? stripSlash(platformUrl) : undefined,
    classicUrl: classicUrl ? stripSlash(classicUrl) : undefined,
    platformToken,
    apiToken,
    enableWrites: env.DT_ENABLE_WRITES === "true",
    iamToken,
    oauthClientId,
    oauthClientSecret,
    accountUrn,
    ssoTokenUrl: optional(env, "DT_SSO_TOKEN_URL") ?? "https://sso.dynatrace.com/sso/oauth2/token",
    accountApiUrl: stripSlash(optional(env, "DT_ACCOUNT_API_URL") ?? "https://api.dynatrace.com"),
    timeoutMs: env.DT_HTTP_TIMEOUT_MS ? Number(env.DT_HTTP_TIMEOUT_MS) : 30000,
    maxRetries: env.DT_MAX_RETRIES ? Number(env.DT_MAX_RETRIES) : 3,
    retryBaseMs: env.DT_RETRY_BASE_MS ? Number(env.DT_RETRY_BASE_MS) : 500,
  };
}

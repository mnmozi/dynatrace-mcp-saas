import type { Config } from "./types.js";

export type { Config } from "./types.js";

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const v = env[key];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v.trim();
}

const stripSlash = (u: string) => u.replace(/\/+$/, "");

export function loadConfig(env: Env = process.env): Config {
  return {
    platformUrl: stripSlash(required(env, "DT_PLATFORM_URL")),
    classicUrl: stripSlash(required(env, "DT_CLASSIC_URL")),
    platformToken: required(env, "DT_PLATFORM_TOKEN"),
    apiToken: required(env, "DT_API_TOKEN"),
    enableWrites: env.DT_ENABLE_WRITES === "true",
    timeoutMs: env.DT_HTTP_TIMEOUT_MS ? Number(env.DT_HTTP_TIMEOUT_MS) : 30000,
    maxRetries: env.DT_MAX_RETRIES ? Number(env.DT_MAX_RETRIES) : 3,
    retryBaseMs: env.DT_RETRY_BASE_MS ? Number(env.DT_RETRY_BASE_MS) : 500,
  };
}

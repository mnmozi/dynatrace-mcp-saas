/**
 * Shared HTTP retry engine.
 *
 * ONE place that decides whether a failed attempt is retried, so every client
 * (platform, classic, account) behaves identically and can be controlled per call.
 *
 * Retry safety is method/data aware — see classAllowsRetry():
 *   idempotent (GET, PUT-replace, DELETE) → retry on 429/408, 5xx, and network errors
 *   create     (non-idempotent config POST) → retry on 429/408 and network errors,
 *              but NOT 5xx (the write may already have applied; a duplicate config
 *              object is at least visible/deletable by name)
 *   append     (data ingest — logs/spans/bizevents/metrics, lookup upload) → retry
 *              ONLY on 429/408 (rejected before processing). NEVER on 5xx/network,
 *              because a retry would create a DUPLICATE record with no stable identity.
 *
 * The calling class can override the whole decision:
 *   - verifyApplied(): on an otherwise-terminal ambiguous failure, the core calls this
 *     caller-supplied check. Return the resource → treat as success (return it);
 *     return null → retry; omit → fall back to the class default.
 *   - shouldRetry(info): full manual control over the retry predicate.
 */

export type RetryClass = "idempotent" | "create" | "append";

export interface RetryDecisionInfo {
  attempt: number;
  method: string;
  /** HTTP status if a response was received; undefined for a network/timeout error. */
  status?: number;
  networkError: boolean;
}

export interface RequestOpts {
  /** Retry safety class. Defaults from the HTTP method (see defaultClassFor). */
  retryClass?: RetryClass;
  /**
   * Caller-controlled verification for ambiguous write failures. On a failure the
   * class would NOT normally retry (e.g. a create 5xx, or an append network drop),
   * the engine calls this instead of giving up: a non-null return means "the effect
   * landed" — the engine returns it as the successful result; null means "not there"
   * — the engine retries. Omit to use the class default.
   */
  verifyApplied?: () => Promise<unknown | null>;
  /** Full override of the retry predicate. Takes precedence over the class table. */
  shouldRetry?: (info: RetryDecisionInfo) => boolean | Promise<boolean>;
  /** Per-call override of the retry budget. */
  maxRetries?: number;
  /**
   * Override the request Content-Type (default application/json for JSON bodies).
   * Used e.g. for bizevents CloudEvent ingest (application/cloudevent+json).
   */
  contentType?: string;
}

export interface RetryEngineConfig {
  maxRetries: number;
  baseMs: number;
  timeoutMs: number;
}

/** Outcome of the engine: either a Response to parse, or a caller-verified value. */
export type RetryOutcome = { kind: "response"; response: Response } | { kind: "verified"; value: unknown };

/** Default retry class from the HTTP method. Non-idempotent POST defaults to "create". */
export function defaultClassFor(method: string): RetryClass {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "PUT" || m === "DELETE") return "idempotent";
  return "create";
}

/** The deterministic retry table (used when no shouldRetry override is supplied). */
export function classAllowsRetry(cls: RetryClass, status: number | undefined, networkError: boolean): boolean {
  // 429 (rate limited) / 408 (request timeout) = rejected BEFORE processing → always safe.
  if (status === 429 || status === 408) return true;
  if (typeof status === "number" && status >= 500) {
    // 5xx is ambiguous (may have applied). Only re-run when re-running is a no-op.
    return cls === "idempotent";
  }
  if (networkError) {
    // No response — for idempotent it's safe; for create a duplicate is visible/deletable;
    // for append (no identity) a duplicate is silent data corruption → do not retry.
    return cls === "idempotent" || cls === "create";
  }
  // Any other status (2xx handled by caller, other 4xx, 3xx) is terminal.
  return false;
}

function backoffMs(baseMs: number, attemptIndex: number): number {
  const exponential = baseMs * Math.pow(2, attemptIndex);
  const jitter = Math.random() * 100;
  return Math.min(exponential + jitter, 10_000);
}

/** Parse Retry-After (seconds or HTTP-date) → ms, capped at 30 s; null if unparseable. */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds) && /^\d+$/.test(trimmed)) return Math.min(seconds * 1000, 30_000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), 30_000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a fetch with retries. `attempt` performs one request with the given abort signal;
 * the engine handles timeout, the retry decision, backoff, Retry-After, verifyApplied,
 * and the DELETE-404-on-retry=success case. Returns a RetryOutcome; on a terminal
 * network error it rethrows the underlying error for the caller to normalize.
 */
export async function runWithRetry(
  attempt: (signal: AbortSignal) => Promise<Response>,
  cfg: RetryEngineConfig,
  method: string,
  opts?: RequestOpts,
): Promise<RetryOutcome> {
  const cls = opts?.retryClass ?? defaultClassFor(method);
  const maxRetries = opts?.maxRetries ?? cfg.maxRetries;
  let lastResponse: Response | undefined;
  let lastError: unknown;

  const decide = async (info: RetryDecisionInfo): Promise<boolean> =>
    opts?.shouldRetry ? await opts.shouldRetry(info) : classAllowsRetry(cls, info.status, info.networkError);

  // If the class would NOT retry but a verifier is supplied, consult it before giving up.
  const verifyOrGiveUp = async (): Promise<RetryOutcome | undefined> => {
    if (!opts?.verifyApplied) return undefined;
    const found = await opts.verifyApplied();
    if (found !== null && found !== undefined) return { kind: "verified", value: found };
    return undefined; // not there → let the caller retry if budget remains
  };

  for (let attemptIdx = 0; attemptIdx <= maxRetries; attemptIdx++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await attempt(controller.signal);
      clearTimeout(timer);

      if (res.ok) return { kind: "response", response: res };

      // A DELETE that 404s on a RETRY (not the first attempt) means the first attempt
      // already removed it — treat as success rather than a spurious not-found error.
      // Signal it as a verified value so the caller doesn't re-interpret the 404 body
      // as an error (res.ok is false, so returning the raw Response would throw).
      if (method.toUpperCase() === "DELETE" && res.status === 404 && attemptIdx > 0) {
        return { kind: "verified", value: { deleted: true, alreadyGone: true } };
      }

      lastResponse = res;
      const info: RetryDecisionInfo = { attempt: attemptIdx, method, status: res.status, networkError: false };
      const wantRetry = await decide(info);
      const hasBudget = attemptIdx < maxRetries;

      if (!wantRetry || !hasBudget) {
        // Terminal for the class — but a verifier may still salvage it.
        const verified = await verifyOrGiveUp();
        if (verified) return verified;
        if (!hasBudget && wantRetry) break; // exhausted retries → return lastResponse below
        return { kind: "response", response: res }; // non-retryable → caller builds the error
      }

      // Retry: verifier short-circuit first (ambiguous write may have already applied).
      const verified = await verifyOrGiveUp();
      if (verified) return verified;

      const waitMs =
        res.status === 429 ? (parseRetryAfterMs(res.headers.get("Retry-After")) ?? backoffMs(cfg.baseMs, attemptIdx)) : backoffMs(cfg.baseMs, attemptIdx);
      await sleep(waitMs);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const info: RetryDecisionInfo = { attempt: attemptIdx, method, status: undefined, networkError: true };
      const wantRetry = await decide(info);
      const hasBudget = attemptIdx < maxRetries;

      if (!wantRetry || !hasBudget) {
        const verified = await verifyOrGiveUp();
        if (verified) return verified;
        if (!hasBudget && wantRetry) break; // exhausted → rethrow lastError below
        throw err; // non-retryable network error (e.g. append) → surface immediately
      }

      const verified = await verifyOrGiveUp();
      if (verified) return verified;
      await sleep(backoffMs(cfg.baseMs, attemptIdx));
    }
  }

  if (lastResponse !== undefined) return { kind: "response", response: lastResponse };
  throw lastError;
}

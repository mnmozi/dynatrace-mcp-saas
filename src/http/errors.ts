export type HostKind = "classic" | "platform" | "account";

const UNAUTHORIZED: Record<HostKind, string> = {
  platform: "401 Unauthorized: platform APIs need a Bearer platform token (dt0s16). Check DT_PLATFORM_TOKEN.",
  classic: "401 Unauthorized: classic APIs need an Api-Token (dt0c01). Check DT_API_TOKEN.",
  account:
    "401 Unauthorized: the Account Management API rejected the OAuth client. " +
    "Check DT_OAUTH_CLIENT_ID, DT_OAUTH_CLIENT_SECRET and DT_ACCOUNT_URN.",
};

const CREDENTIAL: Record<HostKind, string> = {
  platform: "platform token",
  classic: "classic token",
  account: "account OAuth client",
};

/** `retryAfter` is the raw Retry-After header of a 429 (seconds or an HTTP date). */
export function friendlyMessage(status: number, host: HostKind, retryAfter?: string): string {
  switch (status) {
    case 401:
      return UNAUTHORIZED[host];
    case 403:
      // Dynatrace answers 403 for a missing token scope AND for an IAM policy denial.
      return `403 Forbidden: the ${CREDENTIAL[host]} is missing a required scope or permission for this endpoint.`;
    case 404:
      return "404: resource not found, or this endpoint is unavailable on this tenant.";
    case 429: {
      const wait = retryAfter ? `retry after ${retryAfterText(retryAfter)}` : "retry later";
      return `429 Too Many Requests: rate limited; ${wait}.`;
    }
    default:
      return status >= 500 ? `${status}: Dynatrace server error; retry later.` : `${status}: request failed.`;
  }
}

function retryAfterText(retryAfter: string): string {
  const value = retryAfter.trim();
  return /^\d+$/.test(value) ? `${value} s` : value;
}

/** What Dynatrace said about a failed request, dug out of the response body. */
export interface ApiErrorDetail {
  /** Human-readable explanation, e.g. "The field content doesn't exist." */
  message?: string;
  /** Machine code Dynatrace attached, e.g. FIELD_DOES_NOT_EXIST. Never a copy of `message`. */
  errorType?: string;
  /** DQL exception category, e.g. DQL-SYNTAX-ERROR, DQL-RESULT_TYPE. */
  exceptionType?: string;
  /** 1-based start of the error within a DQL query. */
  position?: QueryPosition;
  /** Raw `constraintViolations` entries from every envelope in the body. */
  violations: unknown[];
  /** Scopes the token lacks, when Dynatrace names them. */
  missingScopes: string[];
  /** Platform APIs state the 429 wait in the body (`error.retryAfterSeconds`) rather than a header. */
  retryAfterSeconds?: number;
}

interface QueryPosition {
  line: number;
  column: number;
}

/**
 * Read an error body in any of the shapes Dynatrace returns:
 * - classic: `{error:{message, constraintViolations}}`
 * - platform: `{error:{message, details:{constraintViolations, missingScopes}}}`
 * - Grail DQL: `{error:{message:<code>, details:{errorMessage, errorType, exceptionType, syntaxErrorPosition}}}`
 *   (also the body of a FAILED `query:poll`)
 * - Settings 2.0 writes: an array of per-object envelopes
 * - account management: top-level `{message}`
 * - SSO (OAuth): `{error:"invalid_scope", error_description:"..."}`
 * - plain text (an HTML error page says nothing useful and is ignored)
 */
export function extractApiErrorDetail(body: unknown): ApiErrorDetail {
  const envelopes = bodyEnvelopes(body);
  const errorType = firstDefined(envelopes.map(envelopeErrorType));
  const messages = unique([...plainTextMessages(body), ...envelopes.flatMap(envelopeMessages)]).filter(
    (message) => message !== errorType,
  );
  return {
    message: messages.length ? messages.join("; ") : undefined,
    errorType,
    exceptionType: firstDefined(envelopes.map((envelope) => nonEmptyString(errorDetails(envelope)?.exceptionType))),
    position: firstDefined(envelopes.map(envelopePosition)),
    violations: envelopes.flatMap(envelopeViolations),
    missingScopes: unique(envelopes.flatMap(envelopeMissingScopes)),
    retryAfterSeconds: firstDefined(envelopes.map(envelopeRetryAfterSeconds)),
  };
}

const MAX_REASON_CHARS = 600;

/**
 * `detail` as one line for an error message, e.g.
 * "The field content doesn't exist. [FIELD_DOES_NOT_EXIST @ line 1, col 56]" or
 * "Constraints violated.; name: Must not be null". Deduplicated and capped; "" when the body said nothing.
 */
export function formatApiErrorDetail(detail: ApiErrorDetail): string {
  const tags = [
    detail.message ? detail.errorType : undefined,
    detail.position ? `line ${detail.position.line}, col ${detail.position.column}` : undefined,
  ].filter(isDefined);
  const headline = [detail.message ?? detail.errorType, tags.length ? `[${tags.join(" @ ")}]` : undefined]
    .filter(isDefined)
    .join(" ");
  const explained = unique([headline || undefined, ...detail.violations.map(violationText)].filter(isDefined));
  const explainedText = explained.join("; ");
  // Dynatrace usually names the missing scopes in its message already; list them only when it does not.
  const scopesNamed = detail.missingScopes.every((scope) => explainedText.includes(scope));
  const parts = scopesNamed ? explained : [...explained, `missing scopes: ${detail.missingScopes.join(", ")}`];
  const reason = parts.join("; ");
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}

/** A response Dynatrace answered with a non-2xx status. */
export class DynatraceApiError extends Error {
  readonly status: number;
  readonly host: HostKind;
  readonly body: unknown;
  readonly path: string;
  /** What Dynatrace said, parsed from `body`. */
  readonly detail: ApiErrorDetail;
  /** `detail` as one line ("" when the body said nothing). */
  readonly reason: string;

  constructor(status: number, host: HostKind, body: unknown, path: string, retryAfterHeader?: string) {
    const detail = extractApiErrorDetail(body);
    const reason = formatApiErrorDetail(detail);
    const retryAfter = retryAfterHeader ?? detail.retryAfterSeconds?.toString();
    super(`${friendlyMessage(status, host, retryAfter)} (${host} ${path})${reason ? ` — ${reason}` : ""}`);
    this.name = "DynatraceApiError";
    this.status = status;
    this.host = host;
    this.body = body;
    this.path = path;
    this.detail = detail;
    this.reason = reason;
  }

  /** `body` is the already-read response body; the Retry-After header feeds the 429 message. */
  static fromResponse(res: Response, host: HostKind, body: unknown, path: string): DynatraceApiError {
    return new DynatraceApiError(res.status, host, body, path, res.headers.get("Retry-After") ?? undefined);
  }
}

/** The request a client was making, named in the error when it gets no response. */
export interface RequestTarget {
  host: HostKind;
  method: string;
  path: string;
  timeoutMs: number;
}

/**
 * A request that got no HTTP response: the connection failed, the client-side timeout fired,
 * or fetch refused to send it. `fetchFailure` is what fetch threw; it is described, not kept
 * as `cause`, because its text can quote the Authorization header.
 */
export class DynatraceNetworkError extends Error {
  constructor(target: RequestTarget, fetchFailure: unknown) {
    super(networkFailureMessage(target, fetchFailure));
    this.name = "DynatraceNetworkError";
  }
}

const HOST_URL_SETTING: Record<HostKind, string> = {
  platform: "DT_PLATFORM_URL",
  classic: "DT_CLASSIC_URL",
  account: "DT_ACCOUNT_API_URL / DT_SSO_TOKEN_URL",
};

const HOST_TOKEN_SETTING: Record<HostKind, string> = {
  platform: "DT_PLATFORM_TOKEN (DT_IAM_TOKEN for IAM tools)",
  classic: "DT_API_TOKEN",
  account: "DT_OAUTH_CLIENT_ID / DT_OAUTH_CLIENT_SECRET",
};

const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

function networkFailureMessage(target: RequestTarget, fetchFailure: unknown): string {
  const request = `(${target.host} ${target.method} ${target.path})`;
  // The only abort source is the per-request timeout timer.
  if (asObject(fetchFailure)?.name === "AbortError") {
    return (
      `Timed out after ${target.timeoutMs} ms waiting for Dynatrace ${request}.` +
      `${appliedWarning(target.method)} Raise DT_HTTP_TIMEOUT_MS if this endpoint is slow.`
    );
  }
  // Node's fetch reports a connection failure as "fetch failed" with the socket error as `cause`.
  const socketFailure = asObject(asObject(fetchFailure)?.cause);
  if (!socketFailure) {
    // fetch refused to build the request. Its own message can quote the Authorization header, so it is not repeated.
    return (
      `Could not send the request ${request}: it was rejected before leaving this machine, usually because ` +
      `the token contains an invalid character (line break or non-ASCII). Check ${HOST_TOKEN_SETTING[target.host]}.`
    );
  }
  return (
    `Could not reach Dynatrace ${request}: ${socketFailureText(socketFailure)}.` +
    `${appliedWarning(target.method)} Check ${HOST_URL_SETTING[target.host]} and network access.`
  );
}

/**
 * A write that got no response is ambiguous: Dynatrace may have processed it before the connection
 * died. That holds even when this attempt never connected, because an earlier retry attempt may have.
 */
function appliedWarning(method: string): string {
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return "";
  return " If this request changes data it may still have been applied — check before retrying.";
}

/** The error code when there is one (an AggregateError holds one per address tried), else the socket error's text. */
function socketFailureText(socketFailure: JsonObject): string {
  const attempts = socketFailure.errors;
  const firstAttempt = Array.isArray(attempts) ? asObject(attempts[0]) : undefined;
  const text =
    nonEmptyString(socketFailure.code) ??
    nonEmptyString(firstAttempt?.code) ??
    nonEmptyString(socketFailure.message) ??
    "connection failed";
  return text.replace(/\.$/, "");
}

type JsonObject = Record<string, unknown>;

/** A body is one envelope, or a Settings 2.0 array of per-object envelopes. */
function bodyEnvelopes(body: unknown): JsonObject[] {
  const items: unknown[] = Array.isArray(body) ? body : [body];
  return items.map(asObject).filter(isDefined);
}

/** A non-JSON body is worth showing unless it is an HTML error page. */
function plainTextMessages(body: unknown): string[] {
  const text = nonEmptyString(body);
  return text && !text.startsWith("<") ? [text] : [];
}

function errorDetails(envelope: JsonObject): JsonObject | undefined {
  return asObject(asObject(envelope.error)?.details);
}

/** Grail puts the human text in `details.errorMessage` and often a bare code in `error.message`. */
function envelopeMessages(envelope: JsonObject): string[] {
  const candidates = [
    nonEmptyString(errorDetails(envelope)?.errorMessage) ?? nonEmptyString(asObject(envelope.error)?.message),
    nonEmptyString(envelope.message),
    nonEmptyString(envelope.error),
    nonEmptyString(envelope.error_description),
  ];
  return candidates.filter(isDefined);
}

/** Machine codes look like FIELD_DOES_NOT_EXIST. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]+$/;

function envelopeErrorType(envelope: JsonObject): string | undefined {
  const declared = nonEmptyString(errorDetails(envelope)?.errorType);
  const message = nonEmptyString(asObject(envelope.error)?.message);
  return declared ?? (message && ERROR_CODE.test(message) ? message : undefined);
}

function envelopePosition(envelope: JsonObject): QueryPosition | undefined {
  const start = asObject(asObject(errorDetails(envelope)?.syntaxErrorPosition)?.start);
  return typeof start?.line === "number" && typeof start?.column === "number"
    ? { line: start.line, column: start.column }
    : undefined;
}

/** Classic APIs put them on `error.constraintViolations`, platform APIs on `error.details.constraintViolations`. */
function envelopeViolations(envelope: JsonObject): unknown[] {
  const candidates = [asObject(envelope.error)?.constraintViolations, errorDetails(envelope)?.constraintViolations];
  return candidates.flatMap((candidate) => (Array.isArray(candidate) ? candidate : []));
}

function envelopeRetryAfterSeconds(envelope: JsonObject): number | undefined {
  const seconds = asObject(envelope.error)?.retryAfterSeconds;
  return typeof seconds === "number" ? seconds : undefined;
}

function envelopeMissingScopes(envelope: JsonObject): string[] {
  const scopes = errorDetails(envelope)?.missingScopes;
  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
}

/** The violating parameter is `path` on classic and most platform APIs, `parameterDescriptor` on the Grail storage APIs. */
function violationText(violation: unknown): string | undefined {
  const fields = asObject(violation);
  const message = nonEmptyString(fields?.message);
  const parameter = nonEmptyString(fields?.path) ?? nonEmptyString(fields?.parameterDescriptor);
  if (parameter) return message ? `${parameter}: ${message}` : parameter;
  return message;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find(isDefined);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export type { QueryParams } from "../types.js";

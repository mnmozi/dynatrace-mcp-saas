export type HostKind = "classic" | "platform" | "account";

export function friendlyMessage(status: number, host: HostKind): string {
  switch (status) {
    case 401:
      return host === "platform"
        ? "401 Unauthorized: platform APIs need a Bearer platform token (dt0s16). Check DT_PLATFORM_TOKEN."
        : "401 Unauthorized: classic APIs need an Api-Token (dt0c01). Check DT_API_TOKEN.";
    case 403:
      return `403 Forbidden: the ${host} token is missing a required scope for this endpoint.`;
    case 404:
      return "404: resource not found, or this endpoint is unavailable on this tenant.";
    case 429:
      return "429 Too Many Requests: rate limited; retry after the indicated delay.";
    default:
      return status >= 500 ? `${status}: Dynatrace server error; retry later.` : `${status}: request failed.`;
  }
}

/** Useful, human/AI-readable detail dug out of a Dynatrace error payload. */
export interface DqlErrorDetail {
  /** Human-readable explanation, e.g. "The field content doesn't exist." */
  message?: string;
  /** Machine code, e.g. FIELD_DOES_NOT_EXIST, UNKNOWN_COMMAND. */
  errorType?: string;
  /** DQL exception category, e.g. DQL-SYNTAX-ERROR, DQL-RESULT_TYPE. */
  exceptionType?: string;
  /** 1-based start position of the error within the query, when available. */
  position?: { line: number; column: number };
}

/**
 * Dig the useful detail out of a Dynatrace error payload.
 *
 * Handles both the API error envelope `{error:{message,code,details}}` returned on a 400
 * from `query:execute`, and a FAILED `query:poll` body carrying the same shape. The richest
 * fields live under `error.details`: `errorMessage` (human text), `errorType` (machine code),
 * `exceptionType`, and `syntaxErrorPosition.start` (line/column). Returns `{}` when nothing
 * recognizable is present, so callers can fall back to the generic message.
 */
export function extractDqlErrorDetail(payload: unknown): DqlErrorDetail {
  if (!payload || typeof payload !== "object") return {};
  const err = (payload as Record<string, unknown>).error;
  if (!err || typeof err !== "object") return {};
  const e = err as Record<string, unknown>;
  const details = (e.details && typeof e.details === "object" ? e.details : {}) as Record<string, unknown>;

  const errMsg = typeof e.message === "string" ? e.message : undefined;
  const message = (typeof details.errorMessage === "string" && details.errorMessage) || errMsg || undefined;
  // `error.message` is frequently the type code itself (e.g. "FIELD_DOES_NOT_EXIST").
  const errorType = (typeof details.errorType === "string" && details.errorType) || errMsg || undefined;
  const exceptionType = typeof details.exceptionType === "string" ? details.exceptionType : undefined;

  let position: { line: number; column: number } | undefined;
  const pos = details.syntaxErrorPosition;
  if (pos && typeof pos === "object") {
    const start = (pos as Record<string, unknown>).start;
    if (start && typeof start === "object") {
      const s = start as Record<string, unknown>;
      if (typeof s.line === "number" && typeof s.column === "number") {
        position = { line: s.line, column: s.column };
      }
    }
  }
  return { message, errorType, exceptionType, position };
}

/**
 * Compact one-line suffix appended to an error message, e.g.
 * " — The field content doesn't exist. [FIELD_DOES_NOT_EXIST @ line 1, col 56]".
 * Returns "" when there is no extractable detail.
 */
export function formatDqlErrorSuffix(d: DqlErrorDetail): string {
  const head = d.message ?? d.errorType;
  if (!head) return "";
  const tags: string[] = [];
  if (d.errorType && d.errorType !== d.message) tags.push(d.errorType);
  if (d.position) tags.push(`line ${d.position.line}, col ${d.position.column}`);
  return ` — ${head}${tags.length ? ` [${tags.join(" @ ")}]` : ""}`;
}

const MAX_REASON_CHARS = 600;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A 4xx body is one envelope, or a Settings 2.0 array of per-object envelopes. */
function bodyEnvelopes(body: unknown): JsonObject[] {
  const items: unknown[] = Array.isArray(body) ? body : [body];
  return items.flatMap((item): JsonObject[] => {
    const envelope = asObject(item);
    return envelope ? [envelope] : [];
  });
}

/**
 * Raw `constraintViolations` entries of one envelope. Classic APIs put them on
 * `error.constraintViolations`, platform APIs on `error.details.constraintViolations`.
 */
function envelopeViolations(envelope: JsonObject): unknown[] {
  const error = asObject(envelope.error);
  const candidates = [error?.constraintViolations, asObject(error?.details)?.constraintViolations];
  return candidates.flatMap((c) => (Array.isArray(c) ? c : []));
}

function violationText(violation: unknown): string | undefined {
  const v = asObject(violation);
  const message = nonEmptyString(v?.message);
  const path = nonEmptyString(v?.path);
  if (path) return message ? `${path}: ${message}` : path;
  return message;
}

/**
 * Reason fragments of one envelope, across the shapes Dynatrace returns:
 * - classic/platform: `{error:{message, constraintViolations | details:{constraintViolations, missingScopes}}}`
 * - account management: top-level `{message}`
 * - SSO (OAuth): `{error:"invalid_scope", error_description:"..."}`
 */
function envelopeReasonParts(envelope: JsonObject): string[] {
  const error = asObject(envelope.error);
  const missingScopes = asObject(error?.details)?.missingScopes;
  const scopes = Array.isArray(missingScopes) ? missingScopes.filter((s) => typeof s === "string") : [];
  const parts = [
    nonEmptyString(error?.message),
    nonEmptyString(envelope.message),
    nonEmptyString(envelope.error),
    nonEmptyString(envelope.error_description),
    ...envelopeViolations(envelope).map(violationText),
    scopes.length ? `missing scopes: ${scopes.join(", ")}` : undefined,
  ];
  return parts.filter((p): p is string => p !== undefined);
}

/** A non-JSON body is worth showing unless it is an HTML error page. */
function plainTextReasonParts(body: unknown): string[] {
  const text = nonEmptyString(body);
  return text && !text.startsWith("<") ? [text] : [];
}

/**
 * Dynatrace-side reason for a 4xx, dug out of the response body (see envelopeReasonParts
 * for the shapes handled; a plain-text body is used as-is). Fragments already present in
 * `skip` (e.g. the DQL suffix) are omitted. Deduplicated and capped. Returns "" when none.
 */
export function extractApiErrorReason(body: unknown, skip = ""): string {
  const parts = [...plainTextReasonParts(body), ...bodyEnvelopes(body).flatMap(envelopeReasonParts)].filter(
    (p) => !skip.includes(p),
  );
  const reason = [...new Set(parts)].join("; ");
  return reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS - 1)}…` : reason;
}

/** Raw `constraintViolations` entries from every envelope in a 4xx body ([] when none). */
export function extractConstraintViolations(body: unknown): unknown[] {
  return bodyEnvelopes(body).flatMap(envelopeViolations);
}

export class DynatraceApiError extends Error {
  readonly status: number;
  readonly host: HostKind;
  readonly body: unknown;
  readonly path: string;
  /** Parsed, human/AI-readable detail extracted from `body` (empty fields when none). */
  readonly detail: DqlErrorDetail;

  constructor(status: number, host: HostKind, body: unknown, path: string) {
    const detail = extractDqlErrorDetail(body);
    const dqlSuffix = formatDqlErrorSuffix(detail);
    const reason = status >= 400 && status < 500 ? extractApiErrorReason(body, dqlSuffix) : "";
    super(`${friendlyMessage(status, host)} (${host} ${path})${dqlSuffix}${reason ? ` — ${reason}` : ""}`);
    this.name = "DynatraceApiError";
    this.status = status;
    this.host = host;
    this.body = body;
    this.path = path;
    this.detail = detail;
  }
}

export type { QueryParams } from "../types.js";

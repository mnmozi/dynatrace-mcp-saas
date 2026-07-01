export type HostKind = "classic" | "platform";

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

export class DynatraceApiError extends Error {
  readonly status: number;
  readonly host: HostKind;
  readonly body: unknown;
  readonly path: string;
  /** Parsed, human/AI-readable detail extracted from `body` (empty fields when none). */
  readonly detail: DqlErrorDetail;

  constructor(status: number, host: HostKind, body: unknown, path: string) {
    const detail = extractDqlErrorDetail(body);
    super(`${friendlyMessage(status, host)} (${host} ${path})${formatDqlErrorSuffix(detail)}`);
    this.name = "DynatraceApiError";
    this.status = status;
    this.host = host;
    this.body = body;
    this.path = path;
    this.detail = detail;
  }
}

export type { QueryParams } from "../types.js";

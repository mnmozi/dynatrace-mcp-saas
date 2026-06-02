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
      return status >= 500
        ? `${status}: Dynatrace server error; retry later.`
        : `${status}: request failed.`;
  }
}

export class DynatraceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly host: HostKind,
    public readonly body: unknown,
    public readonly path: string,
  ) {
    super(`${friendlyMessage(status, host)} (${host} ${path})`);
    this.name = "DynatraceApiError";
  }
}

export type { QueryParams } from "../types.js";

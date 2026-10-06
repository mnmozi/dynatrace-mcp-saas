import { DynatraceNetworkError, type RequestTarget } from "./errors.js";

/**
 * `fetch` for a known request target. A failure without an HTTP response (connection error,
 * client-side timeout) is rethrown naming that target, instead of a bare "fetch failed".
 */
export function fetchForTarget(target: RequestTarget, url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init).catch((fetchFailure: unknown) => {
    throw new DynatraceNetworkError(target, fetchFailure);
  });
}

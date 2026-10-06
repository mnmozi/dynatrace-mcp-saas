import { describe, it, expect } from "vitest";
import {
  DynatraceApiError,
  DynatraceNetworkError,
  friendlyMessage,
  extractApiErrorDetail,
  formatApiErrorDetail,
  type RequestTarget,
} from "../src/http/errors.js";

// Real 400 envelope captured from the tenant for a field-not-found DQL error.
const FIELD_NOT_FOUND_BODY = {
  error: {
    message: "FIELD_DOES_NOT_EXIST",
    code: 400,
    details: {
      exceptionType: "DQL-RESULT_TYPE",
      errorType: "FIELD_DOES_NOT_EXIST",
      errorMessage: "The field content doesn't exist.",
      arguments: ["content"],
      syntaxErrorPosition: { start: { column: 56, index: 55, line: 1 }, end: { column: 62, index: 61, line: 1 } },
    },
  },
};

// Real Settings 2.0 validateOnly rejection shape: one envelope per submitted object.
const SETTINGS_ARRAY_BODY = [
  {
    code: 400,
    error: {
      code: 400,
      message: "Validation failed",
      constraintViolations: [
        { path: "azure/clientSecret", message: "must not be empty", parameterLocation: "PAYLOAD_BODY" },
      ],
    },
  },
  { code: 200, objectId: "ok" },
];

// Two rejected objects in one request, the second with two violations.
const TWO_REJECTED_OBJECTS_BODY = [
  {
    code: 400,
    error: {
      code: 400,
      message: "First object invalid",
      constraintViolations: [{ path: "a/name", message: "too long" }],
    },
  },
  {
    code: 400,
    error: {
      code: 400,
      message: "Second object invalid",
      constraintViolations: [
        { path: "b/type", message: "unknown value" },
        { path: "b/scope", message: "must not be null" },
      ],
    },
  },
];

const reasonOf = (body: unknown) => formatApiErrorDetail(extractApiErrorDetail(body));

describe("friendlyMessage", () => {
  it("names the credential each host needs on a 401", () => {
    expect(friendlyMessage(401, "platform")).toMatch(/Bearer.*platform token/i);
    expect(friendlyMessage(401, "classic")).toMatch(/Api-Token/i);
  });

  it("points an account-host 401 at the OAuth client, not the classic token", () => {
    const message = friendlyMessage(401, "account");
    expect(message).toMatch(/DT_OAUTH_CLIENT_ID/);
    expect(message).not.toMatch(/Api-Token|DT_API_TOKEN/);
  });

  it("explains 403 as a missing scope or permission", () => {
    expect(friendlyMessage(403, "classic")).toBe(
      "403 Forbidden: the classic token is missing a required scope or permission for this endpoint.",
    );
    expect(friendlyMessage(403, "account")).toMatch(/account OAuth client/);
  });

  it("explains 404 as not found / unavailable", () => {
    expect(friendlyMessage(404, "platform")).toMatch(/not found|unavailable/i);
  });

  it("states the Retry-After delay on a 429 when Dynatrace sent one", () => {
    expect(friendlyMessage(429, "platform", "17")).toBe("429 Too Many Requests: rate limited; retry after 17 s.");
    expect(friendlyMessage(429, "platform", "Wed, 21 Oct 2026 07:28:00 GMT")).toContain(
      "retry after Wed, 21 Oct 2026 07:28:00 GMT",
    );
    expect(friendlyMessage(429, "platform")).toBe("429 Too Many Requests: rate limited; retry later.");
  });
});

describe("extractApiErrorDetail", () => {
  it("pulls human message, errorType, exceptionType, and line/column from a real DQL envelope", () => {
    const detail = extractApiErrorDetail(FIELD_NOT_FOUND_BODY);
    expect(detail.message).toBe("The field content doesn't exist.");
    expect(detail.errorType).toBe("FIELD_DOES_NOT_EXIST");
    expect(detail.exceptionType).toBe("DQL-RESULT_TYPE");
    expect(detail.position).toEqual({ line: 1, column: 56 });
  });

  it("treats a bare code in error.message as the errorType, not as the message", () => {
    const detail = extractApiErrorDetail({ error: { message: "UNKNOWN_COMMAND", code: 400 } });
    expect(detail.errorType).toBe("UNKNOWN_COMMAND");
    expect(detail.message).toBeUndefined();
  });

  it("never copies a human message into errorType", () => {
    const detail = extractApiErrorDetail({ error: { code: 401, message: "Unauthorized" } });
    expect(detail.message).toBe("Unauthorized");
    expect(detail.errorType).toBeUndefined();
  });

  it("collects messages and constraintViolations from every envelope of a Settings 2.0 array body", () => {
    const detail = extractApiErrorDetail(TWO_REJECTED_OBJECTS_BODY);
    expect(detail.message).toBe("First object invalid; Second object invalid");
    expect(detail.violations).toEqual([
      { path: "a/name", message: "too long" },
      { path: "b/type", message: "unknown value" },
      { path: "b/scope", message: "must not be null" },
    ]);
  });

  it("reads the 429 wait that platform APIs put in the body", () => {
    const body = { error: { code: 429, message: "Too Many Requests", retryAfterSeconds: 39 } };
    expect(extractApiErrorDetail(body).retryAfterSeconds).toBe(39);
  });

  it("reads platform-style details: constraintViolations and missingScopes", () => {
    const detail = extractApiErrorDetail({
      error: {
        code: 403,
        message: "Forbidden",
        details: {
          missingScopes: ["document:documents:write"],
          constraintViolations: [{ path: "name", message: "must not be blank" }],
        },
      },
    });
    expect(detail.violations).toEqual([{ path: "name", message: "must not be blank" }]);
    expect(detail.missingScopes).toEqual(["document:documents:write"]);
  });

  it("returns nothing for bodies that say nothing", () => {
    const nothing = { violations: [], missingScopes: [] };
    expect(extractApiErrorDetail(undefined)).toEqual(nothing);
    expect(extractApiErrorDetail("")).toEqual(nothing);
    expect(extractApiErrorDetail("<html><body>Bad Gateway</body></html>")).toEqual(nothing);
  });
});

describe("formatApiErrorDetail", () => {
  it("renders a DQL message with its type and position", () => {
    expect(reasonOf(FIELD_NOT_FOUND_BODY)).toBe(
      "The field content doesn't exist. [FIELD_DOES_NOT_EXIST @ line 1, col 56]",
    );
  });

  it("shows a bare code once", () => {
    expect(reasonOf({ error: { message: "UNKNOWN_COMMAND", code: 400 } })).toBe("UNKNOWN_COMMAND");
  });

  it("returns an empty string when there is no detail", () => {
    expect(reasonOf(undefined)).toBe("");
  });

  it("appends every violation of every envelope as 'path: message'", () => {
    expect(reasonOf(TWO_REJECTED_OBJECTS_BODY)).toBe(
      "First object invalid; Second object invalid; a/name: too long; b/type: unknown value; b/scope: must not be null",
    );
  });

  it("names the parameter of a Grail storage violation, which uses parameterDescriptor instead of path", () => {
    // Documented 400 example of the storage query API.
    const body = {
      error: {
        code: 400,
        message: "Constraint Violations",
        details: { constraintViolations: [{ message: "must not be null", parameterDescriptor: "query" }] },
      },
    };
    expect(reasonOf(body)).toBe("Constraint Violations; query: must not be null");
  });

  it("lists missing scopes when the message does not name them", () => {
    const body = {
      error: { code: 403, message: "Forbidden", details: { missingScopes: ["document:documents:write"] } },
    };
    expect(reasonOf(body)).toBe("Forbidden; missing scopes: document:documents:write");
  });

  it("does not repeat missing scopes the message already names", () => {
    const body = {
      error: {
        code: 403,
        message: "Authorization token is missing required scope: storage:logs:read.",
        details: { missingScopes: ["storage:logs:read"] },
      },
    };
    expect(reasonOf(body)).toBe("Authorization token is missing required scope: storage:logs:read.");
  });

  it("reads a top-level message (account management API)", () => {
    expect(reasonOf({ code: 400, message: "Group name already exists" })).toBe("Group name already exists");
  });

  it("reads an OAuth error envelope (SSO token endpoint)", () => {
    expect(reasonOf({ error: "invalid_scope", error_description: "Scope not granted to client" })).toBe(
      "invalid_scope; Scope not granted to client",
    );
  });

  it("uses a plain-text body", () => {
    expect(reasonOf("Constraints violated.")).toBe("Constraints violated.");
  });

  it("caps a very long reason", () => {
    expect(reasonOf([{ error: { message: "x".repeat(2000) } }])).toHaveLength(600);
  });
});

describe("DynatraceApiError", () => {
  it("carries status, host, and body", () => {
    const e = new DynatraceApiError(429, "platform", { error: "rate" }, "/x");
    expect(e.status).toBe(429);
    expect(e.host).toBe("platform");
    expect(e.message).toMatch(/429/);
  });

  it("exposes the parsed detail and its one-line reason", () => {
    const e = new DynatraceApiError(400, "classic", SETTINGS_ARRAY_BODY, "/api/v2/settings/objects");
    expect(e.detail.violations).toHaveLength(1);
    expect(e.reason).toBe("Validation failed; azure/clientSecret: must not be empty");
  });

  it("appends the DQL detail once, with a single separator", () => {
    const e = new DynatraceApiError(400, "platform", FIELD_NOT_FOUND_BODY, "/q");
    expect(e.message).toBe(
      "400: request failed. (platform /q) — The field content doesn't exist. [FIELD_DOES_NOT_EXIST @ line 1, col 56]",
    );
  });

  it("joins message and violations with one separator (real classic 400 shape)", () => {
    const body = {
      error: {
        code: 400,
        message: "Constraints violated.",
        constraintViolations: [{ path: "problemId", message: "is not a valid problem ID", parameterLocation: "PATH" }],
      },
    };
    expect(new DynatraceApiError(400, "classic", body, "/api/v2/problems/x").message).toBe(
      "400: request failed. (classic /api/v2/problems/x) — Constraints violated.; problemId: is not a valid problem ID",
    );
  });

  it("keeps Dynatrace's reason on a 5xx too, violations included", () => {
    const body = {
      error: { code: 500, message: "Internal error", constraintViolations: [{ path: "q", message: "boom" }] },
    };
    expect(new DynatraceApiError(500, "classic", body, "/p").message).toBe(
      "500: Dynatrace server error; retry later. (classic /p) — Internal error; q: boom",
    );
  });

  it("adds nothing for an HTML gateway page", () => {
    expect(new DynatraceApiError(502, "platform", "<html><title>502 Bad Gateway</title></html>", "/p").message).toBe(
      "502: Dynatrace server error; retry later. (platform /p)",
    );
  });

  it("uses the wait stated in a 429 body when there is no Retry-After header", () => {
    const body = { error: { code: 429, message: "Too Many Requests", retryAfterSeconds: 39 } };
    expect(new DynatraceApiError(429, "platform", body, "/x").message).toBe(
      "429 Too Many Requests: rate limited; retry after 39 s. (platform /x) — Too Many Requests",
    );
  });

  it("fromResponse carries the Retry-After header into a 429 message", () => {
    const res = new Response("{}", { status: 429, headers: { "Retry-After": "17" } });
    expect(DynatraceApiError.fromResponse(res, "platform", {}, "/x").message).toBe(
      "429 Too Many Requests: rate limited; retry after 17 s. (platform /x)",
    );
  });
});

describe("DynatraceNetworkError", () => {
  const target = (method: string): RequestTarget => ({
    host: "classic",
    method,
    path: "/api/v2/things/1",
    timeoutMs: 30000,
  });
  const aborted = new DOMException("This operation was aborted", "AbortError");
  const socketFailure = (code: string) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
  const APPLIED_WARNING = "If this request changes data it may still have been applied — check before retrying.";

  it("says a read timed out, on which request, and which setting controls it", () => {
    expect(new DynatraceNetworkError(target("GET"), aborted).message).toBe(
      "Timed out after 30000 ms waiting for Dynatrace (classic GET /api/v2/things/1). " +
        "Raise DT_HTTP_TIMEOUT_MS if this endpoint is slow.",
    );
  });

  it("warns that a timed-out write may still have been applied", () => {
    expect(new DynatraceNetworkError(target("PUT"), aborted).message).toContain(APPLIED_WARNING);
  });

  it("names the socket error code and the URL setting when the host is unreachable", () => {
    expect(new DynatraceNetworkError(target("GET"), socketFailure("ENOTFOUND")).message).toBe(
      "Could not reach Dynatrace (classic GET /api/v2/things/1): ENOTFOUND. Check DT_CLASSIC_URL and network access.",
    );
  });

  it("never claims a write was not sent: an earlier retry attempt may have been delivered", () => {
    const message = new DynatraceNetworkError(target("DELETE"), socketFailure("ECONNREFUSED")).message;
    expect(message).toContain(`ECONNREFUSED. ${APPLIED_WARNING}`);
    expect(message).not.toContain("not sent");
  });

  it("reads the code from the first attempt when several addresses were tried", () => {
    const attempts = [Object.assign(new Error("connect ::1"), { code: "ECONNREFUSED" })];
    const failure = new TypeError("fetch failed", { cause: new AggregateError(attempts) });
    expect(new DynatraceNetworkError(target("GET"), failure).message).toContain(": ECONNREFUSED.");
  });

  it("falls back to the socket error's text when it has no code", () => {
    const failure = new TypeError("fetch failed", { cause: new Error("other side closed.") });
    expect(new DynatraceNetworkError({ ...target("GET"), host: "platform" }, failure).message).toBe(
      "Could not reach Dynatrace (platform GET /api/v2/things/1): other side closed. Check DT_PLATFORM_URL and network access.",
    );
  });

  it("does not repeat fetch's own text when it refused to send, because that text quotes the token", () => {
    // What Node's fetch throws for a header value containing a line break.
    const refusal = new TypeError('Headers.append: "Api-Token dt0c01.SECRET\nPART" is an invalid header value.');
    const e = new DynatraceNetworkError(target("GET"), refusal);
    expect(e.message).toBe(
      "Could not send the request (classic GET /api/v2/things/1): it was rejected before leaving this machine, " +
        "usually because the token contains an invalid character (line break or non-ASCII). Check DT_API_TOKEN.",
    );
    expect(e.cause).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { DynatraceApiError, friendlyMessage, extractDqlErrorDetail, formatDqlErrorSuffix, extractApiErrorReason, extractConstraintViolations } from "../src/http/errors.js";

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

describe("friendlyMessage", () => {
  it("explains 401 with token-type hint", () => {
    expect(friendlyMessage(401, "platform")).toMatch(/Bearer.*platform token/i);
    expect(friendlyMessage(401, "classic")).toMatch(/Api-Token/i);
  });
  it("explains 403 as missing scope", () => {
    expect(friendlyMessage(403, "classic")).toMatch(/scope/i);
  });
  it("explains 404 as not found / unavailable", () => {
    expect(friendlyMessage(404, "platform")).toMatch(/not found|unavailable/i);
  });
});

describe("extractDqlErrorDetail", () => {
  it("pulls human message, errorType, exceptionType, and line/column from a real envelope", () => {
    const d = extractDqlErrorDetail(FIELD_NOT_FOUND_BODY);
    expect(d.message).toBe("The field content doesn't exist.");
    expect(d.errorType).toBe("FIELD_DOES_NOT_EXIST");
    expect(d.exceptionType).toBe("DQL-RESULT_TYPE");
    expect(d.position).toEqual({ line: 1, column: 56 });
  });

  it("falls back to error.message as the type code when details are absent", () => {
    const d = extractDqlErrorDetail({ error: { message: "UNKNOWN_COMMAND", code: 400 } });
    expect(d.message).toBe("UNKNOWN_COMMAND");
    expect(d.errorType).toBe("UNKNOWN_COMMAND");
    expect(d.position).toBeUndefined();
  });

  it("returns an empty object for unrecognized payloads", () => {
    expect(extractDqlErrorDetail(undefined)).toEqual({});
    expect(extractDqlErrorDetail("nope")).toEqual({});
    expect(extractDqlErrorDetail({ error: "rate" })).toEqual({});
  });
});

describe("formatDqlErrorSuffix", () => {
  it("renders message with type and position", () => {
    const d = extractDqlErrorDetail(FIELD_NOT_FOUND_BODY);
    expect(formatDqlErrorSuffix(d)).toBe(" — The field content doesn't exist. [FIELD_DOES_NOT_EXIST @ line 1, col 56]");
  });

  it("does not duplicate the type when it equals the message", () => {
    expect(formatDqlErrorSuffix({ message: "UNKNOWN_COMMAND", errorType: "UNKNOWN_COMMAND" })).toBe(
      " — UNKNOWN_COMMAND",
    );
  });

  it("returns empty string when there is no detail", () => {
    expect(formatDqlErrorSuffix({})).toBe("");
  });
});

describe("DynatraceApiError", () => {
  it("carries status, host, and body", () => {
    const e = new DynatraceApiError(429, "platform", { error: "rate" }, "/x");
    expect(e.status).toBe(429);
    expect(e.host).toBe("platform");
    expect(e.message).toMatch(/429/);
  });

  it("enriches the message with extracted DQL detail and exposes it on .detail", () => {
    const e = new DynatraceApiError(400, "platform", FIELD_NOT_FOUND_BODY, "/platform/storage/query/v1/query:execute");
    expect(e.message).toContain("The field content doesn't exist.");
    expect(e.message).toContain("line 1, col 56");
    expect(e.detail.errorType).toBe("FIELD_DOES_NOT_EXIST");
    expect(e.detail.position).toEqual({ line: 1, column: 56 });
  });

  it("leaves the DQL message unchanged (no duplicated reason)", () => {
    const e = new DynatraceApiError(400, "platform", FIELD_NOT_FOUND_BODY, "/q");
    expect(e.message).toBe(
      "400: request failed. (platform /q) — The field content doesn't exist. [FIELD_DOES_NOT_EXIST @ line 1, col 56]",
    );
  });

  it("includes error.message from a plain 4xx envelope", () => {
    const e = new DynatraceApiError(400, "classic", { error: { code: 400, message: "boom" } }, "/api/v2/settings/objects");
    expect(e.message).toContain("boom");
    expect(e.message.match(/boom/g)).toHaveLength(1);
  });

  it("includes path and message from a Settings 2.0 array body with constraintViolations", () => {
    const body = [
      {
        code: 400,
        error: {
          code: 400,
          message: "Validation failed",
          constraintViolations: [{ path: "azure/clientSecret", message: "must not be empty", parameterLocation: "PAYLOAD_BODY" }],
        },
      },
      { code: 200, objectId: "ok" },
    ];
    const e = new DynatraceApiError(400, "classic", body, "/api/v2/settings/objects");
    expect(e.message).toBe(
      "400: request failed. (classic /api/v2/settings/objects) — Validation failed; azure/clientSecret: must not be empty",
    );
  });

  it("truncates a long reason and skips it for 5xx", () => {
    const long = "x".repeat(2000);
    const e = new DynatraceApiError(400, "classic", [{ error: { message: long } }], "/p");
    expect(extractApiErrorReason([{ error: { message: long } }]).length).toBe(600);
    expect(e.message.length).toBeLessThan(700);
    expect(new DynatraceApiError(500, "classic", [{ error: { message: "nope" } }], "/p").message).not.toContain("nope");
  });

  it("reads platform-style details: constraintViolations and missingScopes", () => {
    const body = {
      error: {
        code: 403,
        message: "Forbidden",
        details: {
          missingScopes: ["document:documents:write"],
          constraintViolations: [{ path: "name", message: "must not be blank" }],
        },
      },
    };
    expect(extractApiErrorReason(body)).toBe(
      "Forbidden; name: must not be blank; missing scopes: document:documents:write",
    );
    expect(extractConstraintViolations(body)).toEqual([{ path: "name", message: "must not be blank" }]);
  });

  it("reads a top-level message (account management API)", () => {
    expect(extractApiErrorReason({ code: 400, message: "Group name already exists" })).toBe("Group name already exists");
  });

  it("reads an OAuth error envelope (SSO token endpoint)", () => {
    expect(extractApiErrorReason({ error: "invalid_scope", error_description: "Scope not granted to client" })).toBe(
      "invalid_scope; Scope not granted to client",
    );
  });

  it("uses a plain-text body but ignores an HTML error page", () => {
    expect(extractApiErrorReason("Constraints violated.")).toBe("Constraints violated.");
    expect(extractApiErrorReason("<html><body>Bad Request</body></html>")).toBe("");
  });
});

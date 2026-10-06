import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { listAllSettingsObjects } from "../../src/util/settings-objects.js";
import { DynatraceClient } from "../../src/http/client.js";
import type { Config } from "../../src/types.js";

const OBJECTS_URL = "https://classic.example.com/api/v2/settings/objects";

const cfg: Config = {
  platformUrl: undefined,
  classicUrl: "https://classic.example.com",
  platformToken: undefined,
  apiToken: "A",
  enableWrites: false,
  timeoutMs: 5000,
  maxRetries: 0,
  retryBaseMs: 1,
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const classic = () => new DynatraceClient(cfg).classic;

function settingsObject(objectId: string) {
  return { objectId, schemaId: "builtin:tags", scope: "environment", value: { key: objectId } };
}

/** Serve `pages` in order, recording each request's query string. */
function servePages(pages: Array<{ items: unknown[]; nextPageKey?: string }>) {
  const queries: Array<Record<string, string>> = [];
  server.use(
    http.get(OBJECTS_URL, ({ request }) => {
      queries.push(Object.fromEntries(new URL(request.url).searchParams));
      return HttpResponse.json(pages[queries.length - 1]);
    }),
  );
  return queries;
}

describe("listAllSettingsObjects", () => {
  it("asks for the given schemas at the given scope, with the fields a caller needs", async () => {
    const queries = servePages([{ items: [settingsObject("o1")] }]);

    await listAllSettingsObjects(classic(), { schemaIds: ["builtin:a", "builtin:b"], scope: "HOST-1" });

    expect(queries).toEqual([
      { schemaIds: "builtin:a,builtin:b", scopes: "HOST-1", pageSize: "500", fields: "objectId,value,scope,schemaId" },
    ]);
  });

  it("returns the objects of every page, in page order", async () => {
    servePages([
      { items: [settingsObject("o1"), settingsObject("o2")], nextPageKey: "PAGE2" },
      { items: [settingsObject("o3")], nextPageKey: "PAGE3" },
      { items: [settingsObject("o4")] },
    ]);

    const objects = await listAllSettingsObjects(classic(), { schemaIds: ["builtin:tags"], scope: "environment" });

    expect(objects.map((o) => o.objectId)).toEqual(["o1", "o2", "o3", "o4"]);
  });

  it("sends only nextPageKey on follow-up pages (the classic API rejects it next to other filters)", async () => {
    const queries = servePages([{ items: [], nextPageKey: "PAGE2" }, { items: [] }]);

    await listAllSettingsObjects(classic(), { schemaIds: ["builtin:tags"], scope: "environment" });

    expect(queries[1]).toEqual({ nextPageKey: "PAGE2" });
  });

  it("returns an empty list when the scope has no objects", async () => {
    servePages([{ items: [] }]);

    expect(await listAllSettingsObjects(classic(), { schemaIds: ["builtin:tags"], scope: "environment" })).toEqual([]);
  });

  it("fails instead of truncating when the pages do not end within the cap", async () => {
    let requestCount = 0;
    server.use(
      http.get(OBJECTS_URL, () => {
        requestCount++;
        return HttpResponse.json({ items: [settingsObject(`o${requestCount}`)], nextPageKey: "MORE" });
      }),
    );

    await expect(
      listAllSettingsObjects(classic(), { schemaIds: ["builtin:tags"], scope: "environment" }),
    ).rejects.toThrow(/builtin:tags.*'environment'.*more than 20 pages/);
    expect(requestCount).toBe(20);
  });
});

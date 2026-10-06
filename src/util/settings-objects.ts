import type { HostClient, QueryParams } from "../types.js";

export interface SettingsObject {
  objectId: string;
  schemaId: string;
  scope: string;
  value: Record<string, unknown>;
}

export interface SettingsObjectFilter {
  schemaIds: readonly string[];
  /** 'environment' or an entity id; only objects persisted AT this scope are returned. */
  scope: string;
}

interface SettingsObjectPage {
  items?: SettingsObject[];
  nextPageKey?: string;
}

const OBJECTS_PATH = "/api/v2/settings/objects";
const PAGE_SIZE = 500;
/** 20 pages of 500 is 10,000 objects: far beyond any schema a tool reads whole. */
const MAX_PAGES = 20;

/**
 * Read every Settings 2.0 object matching the filter, following nextPageKey to the end.
 * Throws once MAX_PAGES is exceeded: a caller summarising "all objects" must never be
 * handed a silently truncated list.
 */
export async function listAllSettingsObjects(
  classic: HostClient,
  filter: SettingsObjectFilter,
): Promise<SettingsObject[]> {
  const objects: SettingsObject[] = [];
  let query: QueryParams = firstPageQuery(filter);
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
    const page = await classic.get<SettingsObjectPage>(OBJECTS_PATH, query);
    objects.push(...(page.items ?? []));
    if (!page.nextPageKey) return objects;
    // The classic API rejects nextPageKey combined with any other filter.
    query = { nextPageKey: page.nextPageKey };
  }
  throw new Error(
    `Settings objects for ${filter.schemaIds.join(", ")} at scope '${filter.scope}' span more than ` +
      `${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} objects). Refusing to return a partial list: ` +
      "use list_settings_objects and page through them with nextPageKey.",
  );
}

function firstPageQuery(filter: SettingsObjectFilter): QueryParams {
  return {
    schemaIds: filter.schemaIds.join(","),
    scopes: filter.scope,
    pageSize: PAGE_SIZE,
    fields: "objectId,value,scope,schemaId",
  };
}

import type { AccountClient } from "../http/account.js";

const IDM_READ = "account-idm-read";

interface AccountGroup {
  uuid?: string;
  name?: string;
  [k: string]: unknown;
}

/**
 * Fetch a single account group.
 *
 * The account IDM API has NO single-group GET: `/iam/v1/accounts/{uuid}/groups/{groupUuid}`
 * returns 404 (live-verified), while the list endpoint and the group's sub-resources
 * (/users, /permissions) work. So resolve the group by listing and selecting.
 */
export async function findAccountGroup(account: AccountClient, groupUuid: string): Promise<AccountGroup> {
  const list = await account.get<{ items?: AccountGroup[] }>(
    `/iam/v1/accounts/${encodeURIComponent(account.accountUuid)}/groups`,
    undefined,
    IDM_READ,
  );
  const group = list.items?.find((g) => g.uuid === groupUuid);
  if (!group) {
    throw new Error(`Account group '${groupUuid}' not found on this account.`);
  }
  return group;
}

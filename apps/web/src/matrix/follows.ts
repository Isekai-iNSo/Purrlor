import type { MatrixClient } from 'matrix-js-sdk';
import { readFreshAccountData } from './freshAccountData';
import { publishFollow } from './profileFeed';

/**
 * Who and what you follow, for the global feed's Following timeline. Stored in your own account
 * data, which is what the Following timeline reads. Following a **person** is also published on
 * your profile (profileFeed.ts, publishFollow) — that's what follower counts and lists are made of,
 * and it tells them. Following a **Space** stays private: nothing is sent anywhere.
 */
export const FOLLOWS_ACCOUNT_DATA = 'xyz.nekous.follows';

export type Follows = { users: string[]; spaces: string[] };

const EMPTY: Follows = { users: [], spaces: [] };

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

export function readFollows(mx: MatrixClient): Follows {
  const content = mx.getAccountData(FOLLOWS_ACCOUNT_DATA as any)?.getContent<Record<string, unknown>>();
  if (!content) return EMPTY;
  return { users: stringList(content.users), spaces: stringList(content.spaces) };
}

/** Pure toggle, so the list logic is testable without a client. */
export function toggleFollow(follows: Follows, kind: 'user' | 'space', id: string): Follows {
  const key = kind === 'user' ? 'users' : 'spaces';
  const list = follows[key];
  const next = list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  return { ...follows, [key]: next };
}

/** Toggles against the list as the server has it now, so a follow made on another device a moment
 *  ago isn't dropped (freshAccountData.ts). */
export async function setFollowing(mx: MatrixClient, kind: 'user' | 'space', id: string): Promise<void> {
  const fresh = await readFreshAccountData<Record<string, unknown>>(mx, FOLLOWS_ACCOUNT_DATA);
  const current: Follows = fresh ? { users: stringList(fresh.users), spaces: stringList(fresh.spaces) } : readFollows(mx);
  const next = toggleFollow(current, kind, id);
  await mx.setAccountData(FOLLOWS_ACCOUNT_DATA as any, next as any);
  if (kind === 'user') {
    const myUserId = mx.getUserId() ?? '';
    // Best-effort: the follow is already in effect for your own timeline; a profile room that
    // can't be written right now only means the count elsewhere lags until the next toggle.
    await publishFollow(mx, id, next.users.includes(id), mx.getUser(myUserId)?.displayName || myUserId).catch(() => undefined);
  }
}

import { useEffect, useState } from 'react';
import type { MatrixClient, RoomMember } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';

export type BasicProfile = { name: string; avatarUrl: string | null };

// People in a feed or list you haven't joined aren't in any room this client has, so their names
// come from the profile API — once per person per session.
const profileCache = new Map<string, Promise<BasicProfile>>();

export function lookupProfile(mx: MatrixClient, userId: string): Promise<BasicProfile> {
  let cached = profileCache.get(userId);
  if (!cached) {
    cached = mx
      .getProfileInfo(userId)
      .then((p) => ({ name: p.displayname || userId, avatarUrl: p.avatar_url ?? null }))
      .catch(() => ({ name: userId, avatarUrl: null }));
    profileCache.set(userId, cached);
  }
  return cached;
}

/**
 * Someone's name and avatar: from `members` when they're one (already synced, and their
 * per-room name), otherwise from the profile API. Shows the user ID until that answers.
 */
export function useUserProfile(userId: string, members: RoomMember[] = []): BasicProfile {
  const mx = useMatrixClient();
  const member = members.find((m) => m.userId === userId);
  const known = member ? { name: member.name, avatarUrl: member.getMxcAvatarUrl() ?? null } : undefined;
  const [fetched, setFetched] = useState<BasicProfile>();
  useEffect(() => {
    if (known) return undefined;
    let cancelled = false;
    void lookupProfile(mx, userId).then((p) => {
      if (!cancelled) setFetched(p);
    });
    return () => {
      cancelled = true;
    };
    // `known` is derived from members; re-running on its identity would refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, userId, !!known]);
  return known ?? fetched ?? { name: userId, avatarUrl: null };
}

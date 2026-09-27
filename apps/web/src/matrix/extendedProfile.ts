import type { MatrixClient } from 'matrix-js-sdk';

/**
 * Discord-style profile extras Matrix's own global profile has no room for (it's just
 * displayname + avatar_url) — a bio, a banner image, and whether the current avatar is animated
 * (so Avatar.tsx knows to skip thumbnailing it, see below). Built on MSC4133 "extended profiles"
 * (https://github.com/tcpipuk/matrix-spec-proposals/blob/main/proposals/4133-extended-profiles.md),
 * which matrix-js-sdk already has full native support for (getExtendedProfile,
 * setExtendedProfileProperty, etc.) — this module is just Purrlor's namespaced keys on top of
 * that, not a new protocol. Custom status text already exists as a *real* Matrix feature
 * (presence's `status_msg`, see matrix/account.ts's updateOwnPresence) and isn't duplicated here.
 *
 * Unlike a room/Space state event, these are global — the same bio/banner/animated-avatar show
 * up in every room and DM, exactly like Discord's one profile — but Matrix has no live-sync
 * mechanism for extended-profile changes (unlike displayname/avatar_url, which piggyback on
 * `m.room.member`), so there's no way to push an update to everyone watching in real time.
 * Callers refetch on demand (opening a profile) rather than expecting live reactivity.
 */
const PROFILE_KEYS = {
  bio: 'xyz.nekous.bio',
  bannerUrl: 'xyz.nekous.banner_url',
  avatarAnimated: 'xyz.nekous.avatar_animated',
  // Where this person's global posts live (profileFeed.ts) — published here so anyone can find
  // a profile's posts from just a user ID, without scanning the room directory.
  profileRoom: 'xyz.nekous.profile_room',
  // Your word for "typing" in the typing indicator — "Alice is yelling…" (typingVerb.ts).
  typingVerb: 'xyz.nekous.typing_verb',
  // The post pinned to the top of your profile: `{ room_id, event_id }`. Only a post anyone can
  // read (Global, or a public Space) can be pinned, since the profile is public.
  pinnedPost: 'xyz.nekous.pinned_post',
} as const;

export type PinnedPostRef = { roomId: string; eventId: string };

function readPinnedPost(raw: unknown): PinnedPostRef | undefined {
  const r = raw as { room_id?: unknown; event_id?: unknown } | null;
  return r && typeof r.room_id === 'string' && typeof r.event_id === 'string' ? { roomId: r.room_id, eventId: r.event_id } : undefined;
}

export type ExtendedProfile = {
  bio?: string;
  bannerUrl?: string;
  avatarAnimated?: boolean;
  profileRoom?: string;
  typingVerb?: string;
  pinnedPost?: PinnedPostRef;
};

/** Server support is a per-deployment constant, not something that changes mid-session — cached
 *  at module scope so every field read/write doesn't re-ask. */
let supportPromise: Promise<boolean> | undefined;

export function serverSupportsExtendedProfiles(mx: MatrixClient): Promise<boolean> {
  if (!supportPromise) {
    supportPromise = mx.doesServerSupportExtendedProfiles().catch(() => false);
  }
  return supportPromise;
}

/** `M_NOT_FOUND` for a user who's never set any of these (or a server without MSC4133 at all) is
 *  the expected common case, not an error worth surfacing — same "absence is just absence"
 *  posture as the rest of this app's optional-data reads. */
export async function getExtendedProfile(mx: MatrixClient, userId: string): Promise<ExtendedProfile> {
  try {
    const raw = await mx.getExtendedProfile(userId);
    return {
      bio: typeof raw[PROFILE_KEYS.bio] === 'string' ? (raw[PROFILE_KEYS.bio] as string) : undefined,
      bannerUrl: typeof raw[PROFILE_KEYS.bannerUrl] === 'string' ? (raw[PROFILE_KEYS.bannerUrl] as string) : undefined,
      avatarAnimated: raw[PROFILE_KEYS.avatarAnimated] === true,
      profileRoom: typeof raw[PROFILE_KEYS.profileRoom] === 'string' ? (raw[PROFILE_KEYS.profileRoom] as string) : undefined,
      typingVerb: typeof raw[PROFILE_KEYS.typingVerb] === 'string' ? (raw[PROFILE_KEYS.typingVerb] as string) : undefined,
      pinnedPost: readPinnedPost(raw[PROFILE_KEYS.pinnedPost]),
    };
  } catch {
    return {};
  }
}

/** Sets or clears the bio/banner — omitted keys are left untouched, an explicit `''`/`null`
 *  deletes that one key. Writes each key with its own `setExtendedProfileProperty` PUT rather
 *  than one bulk `patchExtendedProfile` PATCH: confirmed live against a real MSC4133-advertising
 *  homeserver that the bulk PATCH endpoint isn't actually implemented there (`405
 *  M_UNRECOGNIZED`) even though it advertises `.stable = true` and the per-key PUT/DELETE
 *  endpoints work fine — a partial implementation, not a Purrlor bug. Per-key writes are also the
 *  more conservative choice generally: they're the more basic MSC4133 operation, more likely to
 *  exist wherever a bulk merge doesn't. */
export async function updateExtendedProfile(
  mx: MatrixClient,
  patch: { bio?: string | null; bannerUrl?: string | null; typingVerb?: string | null }
): Promise<void> {
  const writes: Promise<void>[] = [];

  if (patch.bio !== undefined) {
    writes.push(
      patch.bio
        ? mx.setExtendedProfileProperty(PROFILE_KEYS.bio, patch.bio)
        : mx.deleteExtendedProfileProperty(PROFILE_KEYS.bio).catch(() => {})
    );
  }
  if (patch.bannerUrl !== undefined) {
    writes.push(
      patch.bannerUrl
        ? mx.setExtendedProfileProperty(PROFILE_KEYS.bannerUrl, patch.bannerUrl)
        : mx.deleteExtendedProfileProperty(PROFILE_KEYS.bannerUrl).catch(() => {})
    );
  }

  if (patch.typingVerb !== undefined) {
    writes.push(
      patch.typingVerb
        ? mx.setExtendedProfileProperty(PROFILE_KEYS.typingVerb, patch.typingVerb)
        : mx.deleteExtendedProfileProperty(PROFILE_KEYS.typingVerb).catch(() => {})
    );
  }

  await Promise.all(writes);
}

/** Whether the *types this app itself uploads as an avatar* animate — a real animation check
 *  would mean parsing the file's frame count, not worth it here: a static GIF/WEBP just renders
 *  its one frame identically whether or not it's thumbnailed, so treating the whole mimetype
 *  family as "animated" (skip thumbnailing, see Avatar.tsx) costs nothing in the rare static
 *  case and is exactly what's needed in the common intentionally-animated one. */
/** Best-effort: a server without MSC4133 just means a profile's posts are found through the
 *  directory instead (globalFeed.ts), not that posting should fail. */
export async function setProfileRoom(mx: MatrixClient, roomId: string): Promise<void> {
  await mx.setExtendedProfileProperty(PROFILE_KEYS.profileRoom, roomId).catch(() => {});
}

export function isAnimatableImageType(mimeType: string): boolean {
  return mimeType === 'image/gif' || mimeType === 'image/webp';
}

export async function setAvatarAnimated(mx: MatrixClient, animated: boolean): Promise<void> {
  if (animated) await mx.setExtendedProfileProperty(PROFILE_KEYS.avatarAnimated, true);
  else await mx.deleteExtendedProfileProperty(PROFILE_KEYS.avatarAnimated).catch(() => {});
}

/** Pins a post to the top of your profile, or unpins with `null`. */
export async function setPinnedPost(mx: MatrixClient, post: PinnedPostRef | null): Promise<void> {
  if (post) await mx.setExtendedProfileProperty(PROFILE_KEYS.pinnedPost, { room_id: post.roomId, event_id: post.eventId });
  else await mx.deleteExtendedProfileProperty(PROFILE_KEYS.pinnedPost).catch(() => {});
}

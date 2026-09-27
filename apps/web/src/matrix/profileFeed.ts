import {
  EventType,
  HistoryVisibility,
  JoinRule,
  Visibility,
  type MatrixClient,
} from 'matrix-js-sdk';
import { channelTypeInitialStateEvent } from './channelType';
import { getExtendedProfile, setProfileRoom } from './extendedProfile';
import { FEED_MARKER_EVENT, feedJoinVia, POST_EVENT_TYPE, rejoinOwnRoom } from './feed';

/**
 * A person's **profile feed** — where a post goes when its author picks "Global" instead of one
 * of their Spaces. It's a feed room like any Space member's (feed.ts), with three differences:
 *
 * - It belongs to no Space, so it can't be restricted to one: history is `world_readable` and
 *   the room is **listed in the directory** under its own room type, which is how the global feed
 *   finds every profile on the server (globalFeed.ts) without anyone having to be in anything.
 * - Its room type (`xyz.nekous.profile`) keeps it out of places a listed room would otherwise
 *   appear: Discover filters it out, and its `feed` channel type keeps it out of Direct Messages
 *   once someone joins it.
 * - Its ID is also published on the owner's extended profile, so a profile page can find it from
 *   a user ID alone.
 *
 * One per person, created on their first global post.
 */
export const PROFILE_ROOM_TYPE = 'xyz.nekous.profile';

/** The owner's own record of their profile room — survives anything, unlike the directory. */
const PROFILE_ROOM_ACCOUNT_DATA = 'xyz.nekous.profile_room';

export function getOwnProfileRoomId(mx: MatrixClient): string | undefined {
  const content = mx.getAccountData(PROFILE_ROOM_ACCOUNT_DATA as any)?.getContent<{ roomId?: string }>();
  return typeof content?.roomId === 'string' ? content.roomId : undefined;
}

/**
 * Who a profile room belongs to, from its raw state: the feed marker's owner, cross-checked
 * against the room's creator so a hand-edited marker can't claim someone else's name.
 */
export function readProfileOwner(events: { type: string; state_key?: string; sender?: string; content?: Record<string, unknown> }[]): string | undefined {
  const create = events.find((event) => event.type === EventType.RoomCreate);
  const creator = (create?.content?.creator as string | undefined) ?? create?.sender;
  const marker = events.find((event) => event.type === FEED_MARKER_EVENT && event.state_key === '');
  const owner = marker?.content?.owner;
  if (typeof owner !== 'string' || !owner) return undefined;
  return creator && creator !== owner ? undefined : owner;
}

export async function ensureProfileRoom(mx: MatrixClient, displayName: string): Promise<string> {
  const known = getOwnProfileRoomId(mx);
  // A second profile room would be a second listing in the directory, so the old one is rejoined
  // rather than replaced whenever that's possible.
  if (known && (await rejoinOwnRoom(mx, known))) return known;

  const owner = mx.getUserId();
  const { room_id: roomId } = await mx.createRoom({
    name: displayName,
    topic: `${displayName}'s posts`,
    // Listed, so the global feed can find it. Discover hides it by its room type.
    visibility: Visibility.Public,
    creation_content: { type: PROFILE_ROOM_TYPE },
    power_level_content_override: {
      // Only the owner posts; everyone else keeps the default level, so reactions still work.
      events: { [POST_EVENT_TYPE]: 100 },
    },
    initial_state: [
      { type: EventType.RoomJoinRules, state_key: '', content: { join_rule: JoinRule.Public } },
      { type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: HistoryVisibility.WorldReadable } },
      channelTypeInitialStateEvent('feed'),
      { type: FEED_MARKER_EVENT, state_key: '', content: { owner, profile: true } },
    ],
  });
  await mx.setAccountData(PROFILE_ROOM_ACCOUNT_DATA as any, { roomId } as any);
  await setProfileRoom(mx, roomId);
  return roomId;
}

/**
 * **Public follows.** Following a person is also published, as one state event per person in your
 * own profile room (state key: their user ID; `following: true`, or empty content once you
 * unfollow — state can't be deleted). The room is world-readable, so anyone can read who you
 * follow, and the global feed, which already reads every listed profile room's state, counts who
 * follows whom from the same requests. Following a Space stays private (follows.ts).
 *
 * The person you follow is told with a `xyz.nekous.followed` event in *their* profile room, which
 * they're always in — so it reaches them live, like a like does (activity.ts).
 */
export const FOLLOW_STATE_EVENT = 'xyz.nekous.follow';
export const FOLLOWED_EVENT = 'xyz.nekous.followed';

type RawState = { type: string; state_key?: string; content?: Record<string, unknown> };

/** Who a profile room's owner follows, from its raw state. */
export function readProfileFollows(events: RawState[]): string[] {
  return events
    .filter((event) => event.type === FOLLOW_STATE_EVENT && !!event.state_key && event.content?.following === true)
    .map((event) => event.state_key as string);
}

/**
 * Publishes a follow or unfollow. Following someone creates your profile room if you haven't one
 * yet (it's where the follow is published); unfollowing without one has nothing to take back.
 */
export async function publishFollow(mx: MatrixClient, userId: string, following: boolean, displayName: string): Promise<void> {
  const roomId = following ? await ensureProfileRoom(mx, displayName) : getOwnProfileRoomId(mx);
  if (!roomId) return;
  await mx.sendStateEvent(roomId, FOLLOW_STATE_EVENT as any, (following ? { following: true } : {}) as any, userId);
  if (!following) return;
  // Tell them. Best-effort: someone who has never posted globally has no profile room to tell.
  const { profileRoom } = await getExtendedProfile(mx, userId);
  if (!profileRoom) return;
  try {
    if (mx.getRoom(profileRoom)?.getMyMembership() !== 'join') {
      await mx.joinRoom(profileRoom, { viaServers: feedJoinVia(profileRoom, userId) });
    }
    await mx.sendEvent(profileRoom, FOLLOWED_EVENT as any, {} as any);
  } catch {
    // The follow itself is published either way.
  }
}

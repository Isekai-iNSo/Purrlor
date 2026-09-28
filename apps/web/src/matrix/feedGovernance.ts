import { EventType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { listOwnFeedRooms, POST_EVENT_TYPE, publishFeedPointer, syncFeedVisibility } from './feed';
import { privilegedCreators } from './permissions';
import { isListedInDirectory } from './spaceDirectory';

/**
 * A Space's authority over its members' feed rooms.
 *
 * A feed room isn't a Space child and its owner is the only one with power in it (feed.ts), so
 * nothing the Space does reaches it on its own: banning someone from the Space left them joined to
 * every feed they'd opened — still reading a private Space's posts, still commenting — and a
 * Space moderator couldn't take down an abusive post or comment. Only the owner can change a feed
 * room, so the **owner's client** keeps each of their feeds in line with its Space:
 *
 * - **Membership.** Anyone joined to the feed who is no longer joined to the Space is kicked. A
 *   kick is enough: the restricted join rule only admits Space members, so they can't come back
 *   without rejoining the Space first.
 * - **Moderators.** Whoever can delete messages in the Space (its `redact` level; creators too, on
 *   room version 12) gets power level 50 in the feed: enough to delete posts and comments and to
 *   kick, not enough to post (100) or to change the room — every state event is raised to 100 here,
 *   so a moderator can't make a private Space's feed world-readable or rewrite its feed marker.
 *   Someone who stops being a Space moderator is taken back out.
 * - **Visibility.** History visibility follows the Space being listed or not, as soon as the Space
 *   changes rather than the next time the owner happens to post.
 *
 * This runs while the owner has Purrlor open, so a ban lands in each feed when its owner is next
 * online. Until then the reading side hides comments from anyone who has left or been removed
 * from the Space (isRemovedFromSpace), so a removed member stops being visible straight away.
 */

type PowerLevels = {
  users?: Record<string, number>;
  users_default?: number;
  events?: Record<string, number>;
  state_default?: number;
  redact?: number;
  kick?: number;
  ban?: number;
  [key: string]: unknown;
};

export const FEED_MODERATOR_LEVEL = 50;
const OWNER_ONLY_LEVEL = 100;

function powerLevels(room: Room): PowerLevels {
  return room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent<PowerLevels>() ?? {};
}

/** Who moderates a Space: anyone who can delete other people's messages in it. */
export function spaceModerators(space: Room): string[] {
  const levels = powerLevels(space);
  const threshold = levels.redact ?? 50;
  const listed = Object.entries(levels.users ?? {})
    .filter(([, level]) => typeof level === 'number' && level >= threshold)
    .map(([userId]) => userId);
  return [...new Set([...privilegedCreators(space), ...listed])];
}

/**
 * The power levels a feed room should have, or undefined when it already has them. Pure, so it's
 * tested directly. The owner's own entry is kept exactly as it is — on room version 12 the owner is
 * the creator and must *not* be listed — and every other entry is replaced by the moderator list.
 */
export function wantedFeedPowerLevels(current: PowerLevels, ownerId: string, moderators: string[]): PowerLevels | undefined {
  const users: Record<string, number> = {};
  if (current.users && ownerId in current.users) users[ownerId] = current.users[ownerId];
  moderators.filter((id) => id !== ownerId).forEach((id) => {
    users[id] = FEED_MODERATOR_LEVEL;
  });

  // Every state event the room names is raised to owner-only; the post type stays owner-only.
  const events: Record<string, number> = {};
  Object.entries(current.events ?? {}).forEach(([type, level]) => {
    events[type] = Math.max(level, OWNER_ONLY_LEVEL);
  });
  events[POST_EVENT_TYPE] = OWNER_ONLY_LEVEL;

  const wanted: PowerLevels = {
    ...current,
    users,
    events,
    state_default: OWNER_ONLY_LEVEL,
    redact: FEED_MODERATOR_LEVEL,
    kick: FEED_MODERATOR_LEVEL,
    ban: FEED_MODERATOR_LEVEL,
  };
  return sameLevels(current, wanted) ? undefined : wanted;
}

function sortedEntries(record: Record<string, number> | undefined): [string, number][] {
  return Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

function sameLevels(a: PowerLevels, b: PowerLevels): boolean {
  return (
    JSON.stringify(sortedEntries(a.users)) === JSON.stringify(sortedEntries(b.users)) &&
    JSON.stringify(sortedEntries(a.events)) === JSON.stringify(sortedEntries(b.events)) &&
    a.state_default === b.state_default &&
    a.redact === b.redact &&
    a.kick === b.kick &&
    a.ban === b.ban
  );
}

/** Whether someone has left, or been kicked or banned from, the Space — known for certain, not
 *  merely "not loaded yet". Used to hide their comments before their feed's owner has caught up. */
export function isRemovedFromSpace(space: Room | null | undefined, userId: string): boolean {
  const membership = space?.getMember(userId)?.membership;
  return membership === 'leave' || membership === 'ban';
}

/** Joined members of a feed room who aren't joined to its Space — the ones to remove. */
export function feedMembersToRemove(feed: Room, space: Room, ownerId: string): string[] {
  return feed
    .getJoinedMembers()
    .map((member) => member.userId)
    .filter((userId) => userId !== ownerId && space.getMember(userId)?.membership !== 'join');
}

/** Brings one of your feed rooms in line with its Space. Needs the Space's full member list, so a
 *  member who hasn't been lazy-loaded yet is never mistaken for one who left. */
async function governFeed(mx: MatrixClient, spaceId: string, feedRoomId: string, ownerId: string): Promise<void> {
  const space = mx.getRoom(spaceId);
  const feed = mx.getRoom(feedRoomId);
  if (space?.getMyMembership() !== 'join' || feed?.getMyMembership() !== 'join') return;
  await Promise.all([space.loadMembersIfNeeded(), feed.loadMembersIfNeeded()]);

  // A failed lookup changes nothing: flipping a feed private and back on a network blip would
  // leave the global feed unable to read it in between.
  const listed = await isListedInDirectory(mx, spaceId).catch(() => undefined);
  if (listed !== undefined) await syncFeedVisibility(mx, feedRoomId, listed);

  const levels = wantedFeedPowerLevels(powerLevels(feed), ownerId, spaceModerators(space));
  if (levels) await mx.sendStateEvent(feedRoomId, EventType.RoomPowerLevels, levels as any, '');

  // A profile change rewrites your member event without the pointer, taking this feed out of the
  // Space and the global feed until it's put back.
  await publishFeedPointer(mx, space, feedRoomId);

  // One at a time: a Space-wide purge shouldn't fire a burst of kicks into the rate limiter.
  for (const userId of feedMembersToRemove(feed, space, ownerId)) {
    await mx.kick(feedRoomId, userId, 'No longer a member of this Space').catch(() => undefined);
  }
}

/** Every Space feed you own, or just the ones in `spaceIds`. Failures are per feed. */
export async function governOwnFeeds(mx: MatrixClient, spaceIds?: Set<string>): Promise<void> {
  const ownerId = mx.getUserId();
  if (!ownerId) return;
  for (const { spaceId, roomId } of listOwnFeedRooms(mx)) {
    if (spaceIds && !spaceIds.has(spaceId)) continue;
    await governFeed(mx, spaceId, roomId, ownerId).catch((err: unknown) =>
      console.warn(`Couldn’t update feed ${roomId}`, err)
    );
  }
}

/** Can this user delete other people's posts and comments in a feed room? */
export function canModerateFeed(feed: Room | null | undefined, userId: string): boolean {
  if (feed?.getMyMembership() !== 'join') return false;
  const levels = powerLevels(feed);
  const mine = levels.users?.[userId] ?? (privilegedCreators(feed).includes(userId) ? Infinity : levels.users_default ?? 0);
  return mine >= (levels.redact ?? 50);
}

import {
  Direction,
  EventType,
  MatrixEvent,
  Method,
  RelationType,
  RoomType,
  type IPublicRoomsChunkRoom,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { editTargetOf, FEED_ROOM_MEMBER_KEY, isPostEvent, listSpaceFeeds, POST_EVENT_TYPE, type PostOrigin } from './feed';
import { getExtendedProfile } from './extendedProfile';
import { getOwnProfileRoomId, PROFILE_ROOM_TYPE, readProfileFollows, readProfileOwner } from './profileFeed';
import { isListedInDirectory } from './spaceDirectory';

/**
 * The global feed's reading side: every place a post can come from, gathered without joining
 * anything, and merged into one timeline.
 *
 * **Sources.** A post lives in one room — a *feed room* — owned by its author. There are two kinds:
 *
 * - **Profile feeds** (profileFeed.ts): a person's global posts. Always public; listed in the
 *   directory under their own room type, which is how they're all found.
 * - **Space feeds** (feed.ts): a member's posts inside a Space, found through the pointer on their
 *   member event in that Space.
 *
 * **What's public.** A Space is public when it's listed in the room directory — the Public
 * checkbox. The join rule isn't used, because an invite link also makes a Space "anyone can join"
 * and a Space someone kept unlisted on purpose must never leak onto a global surface. Every
 * source carries `isPublic`, and the **Everyone** timeline shows only public ones.
 *
 * Spaces you're a *member* of are also read (they're already synced), marked not-public. Those
 * posts can reach you on **Following** and on profiles — you're a member, you can already read
 * them — but never on Everyone.
 *
 * **Reading without joining.** A public Space's feed rooms and every profile feed are
 * world-readable, so their posts come from a plain `/messages`. Finding the feeds in a Space you
 * aren't in needs its `/state`, which a server only answers for a non-member when the Space is
 * world-readable — every public Space created from now on is (roomCreation.ts). An older public
 * Space that isn't is skipped and counted.
 *
 * A private Space's feed rooms are members-only (feed.ts), so for Spaces you're in, useGlobalFeed
 * joins them first — as a member you may, and the Space's own Posts page does the same.
 */

const MAX_DIRECTORY_PAGES = 5;
const DIRECTORY_PAGE_SIZE = 50;
/** Hard caps on fan-out — each source costs a request per page of the feed. */
export const MAX_PUBLIC_SPACES = 40;
export const MAX_PROFILES = 100;
export const MAX_FEEDS = 200;
export const FEED_PAGE_SIZE = 30;
export const GLOBAL_FEED_CONCURRENCY = 6;

export type PublicSpace = {
  roomId: string;
  name: string;
  avatarUrl?: string;
  /** From the directory entry — whether a non-member may read the Space's state. */
  worldReadable: boolean;
};

export type DirectoryProfile = { roomId: string; name: string; avatarUrl?: string };

export type FeedSource = {
  roomId: string;
  owner: string;
  ownerName: string;
  ownerAvatarUrl?: string;
  origin: PostOrigin;
  /** Public places only: a listed Space, or anyone's profile feed. */
  isPublic: boolean;
  /** Profile feeds only: who the owner follows, as published on their profile (profileFeed.ts). */
  follows?: string[];
};

export type GlobalPost = {
  eventId: string;
  ts: number;
  event: MatrixEvent;
  source: FeedSource;
};

type RawStateEvent = { type: string; state_key?: string; sender?: string; content?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in globalFeed.test.ts)
// ---------------------------------------------------------------------------

export function toPublicSpace(entry: IPublicRoomsChunkRoom): PublicSpace | undefined {
  if (entry.room_type !== RoomType.Space) return undefined;
  return {
    roomId: entry.room_id,
    name: entry.name || entry.canonical_alias || entry.room_id,
    ...(entry.avatar_url && { avatarUrl: entry.avatar_url }),
    worldReadable: !!entry.world_readable,
  };
}

export function toDirectoryProfile(entry: IPublicRoomsChunkRoom): DirectoryProfile | undefined {
  if (entry.room_type !== PROFILE_ROOM_TYPE || !entry.world_readable) return undefined;
  return { roomId: entry.room_id, name: entry.name || entry.room_id, ...(entry.avatar_url && { avatarUrl: entry.avatar_url }) };
}

/**
 * Feed sources from a Space's raw member events — the same pointer `listSpaceFeeds` reads from a
 * synced Room, applied to the output of `/state`. Only joined members count: leaving a Space
 * takes your posts out of every view of it.
 */
export function feedSourcesFromState(
  space: { roomId: string; name: string },
  events: RawStateEvent[],
  isPublic: boolean
): FeedSource[] {
  const sources: FeedSource[] = [];
  events.forEach((event) => {
    if (event.type !== EventType.RoomMember || !event.state_key) return;
    const content = event.content ?? {};
    if (content.membership !== 'join') return;
    const roomId = content[FEED_ROOM_MEMBER_KEY];
    if (typeof roomId !== 'string' || !roomId) return;
    sources.push({
      roomId,
      owner: event.state_key,
      ownerName: typeof content.displayname === 'string' && content.displayname ? content.displayname : event.state_key,
      ...(typeof content.avatar_url === 'string' && content.avatar_url && { ownerAvatarUrl: content.avatar_url }),
      origin: { kind: 'space', spaceId: space.roomId, spaceName: space.name },
      isPublic,
    });
  });
  return sources;
}

/** A profile feed's source from its raw `/state`, or undefined if its ownership doesn't check out. */
export function profileSourceFromState(roomId: string, events: RawStateEvent[]): FeedSource | undefined {
  const owner = readProfileOwner(events);
  if (!owner) return undefined;
  const member = events.find((event) => event.type === EventType.RoomMember && event.state_key === owner)?.content ?? {};
  return {
    roomId,
    owner,
    ownerName: typeof member.displayname === 'string' && member.displayname ? member.displayname : owner,
    ...(typeof member.avatar_url === 'string' && member.avatar_url && { ownerAvatarUrl: member.avatar_url }),
    origin: { kind: 'global' },
    isPublic: true,
    follows: readProfileFollows(events),
  };
}

/** Posts in a page of feed-room events: only `xyz.nekous.post`, only by the feed's owner. */
export function postsFromEvents(source: FeedSource, events: MatrixEvent[]): GlobalPost[] {
  const posts: GlobalPost[] = [];
  events.forEach((event) => {
    const eventId = event.getId();
    if (!eventId || !isPostEvent(event) || event.getSender() !== source.owner) return;
    posts.push({ eventId, ts: event.getTs(), event, source });
  });
  return posts;
}

/** Union of two post lists, newest first, one entry per event. */
export function mergePosts(existing: GlobalPost[], incoming: GlobalPost[]): GlobalPost[] {
  const byId = new Map(existing.map((post) => [post.eventId, post]));
  incoming.forEach((post) => byId.set(post.eventId, post));
  return [...byId.values()].sort((a, b) => b.ts - a.ts);
}

/** Sources de-duplicated by room — a public Space you're also in is read once, as public. */
export function dedupeSources(sources: FeedSource[]): FeedSource[] {
  const byRoom = new Map<string, FeedSource>();
  sources.forEach((source) => {
    const existing = byRoom.get(source.roomId);
    if (!existing || (!existing.isPublic && source.isPublic)) byRoom.set(source.roomId, source);
  });
  return [...byRoom.values()];
}

export type TimelineFilter =
  | { kind: 'everyone' }
  | { kind: 'following'; users: string[]; spaces: string[] }
  | { kind: 'profile'; userId: string };

/** Which posts a timeline shows. Everyone is public-only, always — see the module comment. */
export function filterPosts(posts: GlobalPost[], filter: TimelineFilter): GlobalPost[] {
  switch (filter.kind) {
    case 'everyone':
      return posts.filter((post) => post.source.isPublic);
    case 'following':
      return posts.filter(
        ({ source }) =>
          filter.users.includes(source.owner) ||
          (source.origin.kind === 'space' && filter.spaces.includes(source.origin.spaceId))
      );
    case 'profile':
      return posts.filter((post) => post.source.owner === filter.userId);
    default:
      return posts;
  }
}

/** Runs `task` over `items` with at most `limit` in flight. Failures resolve to undefined. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index]);
      } catch {
        results[index] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Public Spaces and profile feeds listed in this homeserver's directory, up to the caps.
 * `truncated` says the directory had more than was read. The caps follow directory order, not
 * activity, so on a big server Everyone is a sample; people and Spaces you follow are read
 * regardless (loadFollowedUserSource, loadFollowedSpaceSources).
 */
export async function listDirectory(
  mx: MatrixClient
): Promise<{ spaces: PublicSpace[]; profiles: DirectoryProfile[]; truncated: boolean }> {
  const spaces: PublicSpace[] = [];
  const profiles: DirectoryProfile[] = [];
  let since: string | undefined;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page += 1) {
    const response = await mx.publicRooms({
      limit: DIRECTORY_PAGE_SIZE,
      since,
      filter: { room_types: [RoomType.Space, PROFILE_ROOM_TYPE as RoomType] },
    });
    response.chunk.forEach((entry) => {
      const space = toPublicSpace(entry);
      if (space) spaces.push(space);
      const profile = toDirectoryProfile(entry);
      if (profile) profiles.push(profile);
    });
    since = response.next_batch;
    if (!since || (spaces.length >= MAX_PUBLIC_SPACES && profiles.length >= MAX_PROFILES)) break;
  }
  return {
    spaces: spaces.slice(0, MAX_PUBLIC_SPACES),
    profiles: profiles.slice(0, MAX_PROFILES),
    truncated: !!since || spaces.length > MAX_PUBLIC_SPACES || profiles.length > MAX_PROFILES,
  };
}

/**
 * A followed (or viewed) person's profile feed, found from their user ID rather than the directory
 * — so they're never lost past the directory caps. Only if the room's owner checks out as them.
 */
export async function loadUserProfileSource(mx: MatrixClient, userId: string): Promise<FeedSource | undefined> {
  const { profileRoom } = await getExtendedProfile(mx, userId);
  if (!profileRoom) return undefined;
  const source = await loadProfileSource(mx, profileRoom);
  return source?.owner === userId ? source : undefined;
}

/**
 * A followed Space's feeds when it might be past the directory caps. Only a Space that is actually
 * listed counts as public here; a private Space you're in is already read (privateJoinedSpaces),
 * and one you aren't in can't be.
 */
export async function loadListedSpaceSources(mx: MatrixClient, spaceId: string): Promise<FeedSource[] | undefined> {
  if (!(await isListedInDirectory(mx, spaceId))) return undefined;
  const joined = mx.getRoom(spaceId);
  if (joined?.getMyMembership() === 'join') return sourcesFromJoinedSpace(joined, true);
  const state = (await mx.roomState(spaceId)) as RawStateEvent[];
  const nameEvent = state.find((event) => event.type === EventType.RoomName && event.state_key === '');
  const name = typeof nameEvent?.content?.name === 'string' && nameEvent.content.name ? nameEvent.content.name : spaceId;
  return feedSourcesFromState({ roomId: spaceId, name }, state, true);
}

function sourcesFromJoinedSpace(space: Room, isPublic: boolean): FeedSource[] {
  return listSpaceFeeds(space).map(({ userId, roomId }) => {
    const member = space.getMember(userId);
    return {
      roomId,
      owner: userId,
      ownerName: member?.name || userId,
      ...(member?.getMxcAvatarUrl() && { ownerAvatarUrl: member.getMxcAvatarUrl() }),
      origin: { kind: 'space', spaceId: space.roomId, spaceName: space.name },
      isPublic,
    };
  });
}

/**
 * A public Space's feeds: from synced state if you're a member, from `/state` if it's
 * world-readable, `null` when neither is possible.
 */
export async function loadPublicSpaceSources(mx: MatrixClient, space: PublicSpace): Promise<FeedSource[] | null> {
  const joined = mx.getRoom(space.roomId);
  if (joined?.getMyMembership() === 'join') return sourcesFromJoinedSpace(joined, true);
  if (!space.worldReadable) return null;
  return feedSourcesFromState(space, (await mx.roomState(space.roomId)) as RawStateEvent[], true);
}

export async function loadProfileSource(mx: MatrixClient, roomId: string): Promise<FeedSource | undefined> {
  return profileSourceFromState(roomId, (await mx.roomState(roomId)) as RawStateEvent[]);
}

/** Every Space you're a member of that isn't public. */
export function privateJoinedSpaces(mx: MatrixClient, publicSpaceIds: Set<string>): Room[] {
  return mx
    .getRooms()
    .filter((room) => room.isSpaceRoom() && room.getMyMembership() === 'join' && !publicSpaceIds.has(room.roomId));
}

/** Feeds in the Spaces above — read from local state, marked not-public. */
export function privateJoinedSpaceSources(mx: MatrixClient, publicSpaceIds: Set<string>): FeedSource[] {
  return privateJoinedSpaces(mx, publicSpaceIds).flatMap((space) => sourcesFromJoinedSpace(space, false));
}

/** Your own profile feed, which may not be in the directory yet right after your first post. */
export async function ownProfileSource(mx: MatrixClient): Promise<FeedSource | undefined> {
  const roomId = getOwnProfileRoomId(mx);
  return roomId ? loadProfileSource(mx, roomId).catch(() => undefined) : undefined;
}

/** `edits`: post edits seen on this page, to apply to posts from any page (applyPostEdits). */
export type FeedPage = { posts: GlobalPost[]; edits: MatrixEvent[]; nextToken?: string };

/** Edit events on a page: sent as their own events, or bundled by the server into the edited
 *  post's `unsigned["m.relations"]["m.replace"]` (which Synapse does for the latest one). */
export function editsFromRaw(raw: Record<string, any>[]): MatrixEvent[] {
  const edits: MatrixEvent[] = [];
  raw.forEach((event) => {
    const asEvent = new MatrixEvent(event);
    if (editTargetOf(asEvent)) edits.push(asEvent);
    const bundled = event.unsigned?.['m.relations']?.[RelationType.Replace];
    if (bundled && typeof bundled === 'object' && typeof bundled.event_id === 'string' && bundled.type) {
      edits.push(new MatrixEvent(bundled));
    }
  });
  return edits;
}

/** One page of a feed room's history, newest first — no membership needed (world-readable). */
export async function fetchFeedPage(mx: MatrixClient, source: FeedSource, from?: string): Promise<FeedPage> {
  const response = await mx.createMessagesRequest(source.roomId, from ?? null, FEED_PAGE_SIZE, Direction.Backward);
  const chunk = response.chunk ?? [];
  const events = chunk.map((raw) => new MatrixEvent(raw));
  const nextToken = response.end && chunk.length ? response.end : undefined;
  return { posts: postsFromEvents(source, events), edits: editsFromRaw(chunk as Record<string, any>[]), nextToken };
}

/** How many of a feed's newest posts a check for new ones reads. */
const NEWEST_CHECK_SIZE = 10;

/**
 * A feed's newest few posts (and edits), for noticing new ones in a feed this client isn't in —
 * those don't sync, so the global feed asks now and then. Filtered to posts server-side, so a busy
 * run of likes and comments doesn't hide a new post behind them.
 */
export async function fetchNewestPosts(mx: MatrixClient, source: FeedSource): Promise<{ posts: GlobalPost[]; edits: MatrixEvent[] }> {
  const res = await mx.http.authedRequest<{ chunk?: Record<string, any>[] }>(
    Method.Get,
    `/rooms/${encodeURIComponent(source.roomId)}/messages`,
    { dir: Direction.Backward, limit: String(NEWEST_CHECK_SIZE), filter: JSON.stringify({ types: [POST_EVENT_TYPE] }) }
  );
  const chunk = res.chunk ?? [];
  return { posts: postsFromEvents(source, chunk.map((raw) => new MatrixEvent(raw))), edits: editsFromRaw(chunk) };
}

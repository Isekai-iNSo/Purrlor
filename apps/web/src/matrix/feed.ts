import {
  EventType,
  HistoryVisibility,
  JoinRule,
  RelationType,
  RestrictedAllowType,
  Visibility,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { channelTypeInitialStateEvent } from './channelType';
import { readFreshAccountData } from './freshAccountData';
import { readAttachments, type PostAttachment } from './postMedia';
import { serverNameOf } from './roomOrigin';

/**
 * Posts — a per-member timeline inside a Space, so a hub is somewhere you publish under your own
 * name and not only somewhere you chat. The Pleroma-shaped feature without a Pleroma: no second
 * server, no second account, no ActivityPub inbox, and no separate moderation queue.
 *
 * **The constraint that shapes all of this:** Matrix has no per-event visibility. History
 * visibility is a property of the *room*. A "private" flag on an event sitting in a readable
 * room would be decoration — the event is still right there in `/messages` for anyone who can
 * read the room. So privacy here is decided by *where a post lives*, never by a field on it:
 *
 * - **Public** — an `xyz.nekous.post` event in the author's feed room, which is `world_readable`.
 * - **Private** — the author's own account data, exactly where `savedMessages.ts` keeps
 *   bookmarks. No other user can read it, because it was never in a room to begin with.
 *
 * Making a public post private redacts the event and writes its text back to account data;
 * publishing a private one does the reverse. The post gets a new event ID either way, so
 * reactions don't survive the move — which is the honest outcome, since its audience changed.
 */

/**
 * A post. Deliberately its own event type rather than an `m.room.message`, for two reasons: it
 * can be power-level gated on its own (`events: { 'xyz.nekous.post': 100 }` in a feed room, so
 * only the owner posts while everyone keeps the default level for reactions), and a feed room
 * peeked from Element shows nothing rather than a chat log that isn't one. The *content* is
 * message-shaped (`body` / `format` / `formatted_body`), so `renderMessageText` and
 * `buildMessageFormatting` work on it completely unchanged.
 */
export const POST_EVENT_TYPE = 'xyz.nekous.post';

/** Marks a room as someone's feed and records whose — read by anything that has the room but not
 *  the Space it belongs to (the timeline renderer, mainly). */
export const FEED_MARKER_EVENT = 'xyz.nekous.feed';

/**
 * Where a member's feed room ID is published: a custom key on their *own* `m.room.member` event
 * in the Space.
 *
 * This is the one piece of Matrix plumbing worth explaining. Discovery has to be writable by an
 * ordinary member and readable by everyone, and the obvious candidates both fail: `m.space.child`
 * needs state permission in the Space (and handing that out is exactly the hole the voice
 * tenancy gate closes — a member who can add Space children can add their own room and claim
 * voice service for it), while account data is private to its owner. Your own member event is
 * the one piece of Space state you can always write and everyone can always read, and it's
 * already synced, so reading the whole hub's feeds costs zero requests. `nicknames.ts` leans on
 * the same property for per-Space display names.
 */
export const FEED_ROOM_MEMBER_KEY = 'xyz.nekous.feed_room';

/**
 * The author's own durable record of which room is their feed in each Space, mirroring what they
 * publish in their member event. Member event content doesn't survive leaving and rejoining a
 * Space, and without this a rejoin would silently strand the old feed and start a second one.
 */
const FEED_ROOMS_ACCOUNT_DATA = 'xyz.nekous.feed_rooms';

/** Private posts. Account data, so they are genuinely private rather than flagged-private. */
const PRIVATE_POSTS_ACCOUNT_DATA = 'xyz.nekous.private_posts';

/**
 * Where a post was originally published: a person's global profile feed (profileFeed.ts), or a
 * Space's feed. Carried on reposts so the embed can say where it came from.
 */
export type PostOrigin = { kind: 'global' } | { kind: 'space'; spaceId: string; spaceName: string };

/**
 * A repost, embedded whole: the original's text and media travel inside the repost, so anyone
 * who can read the repost can read what was reposted — without access to the room it came from
 * (which may be a Space they've never joined). Reposting is only offered from and to public
 * places (see canRepost), so copying the content never moves it somewhere more visible than it
 * already was.
 */
export type RepostOf = {
  roomId: string;
  eventId: string;
  sender: string;
  senderName: string;
  origin: PostOrigin;
  ts: number;
  body: string;
  attachments?: PostAttachment[];
  /** The original's content warning and sensitive-media flag travel with the copy, so a repost
   *  never shows uncovered what its author covered. */
  warning?: string;
  sensitive?: boolean;
};

export type PostContent = {
  body: string;
  format?: string;
  formatted_body?: string;
  attachments?: PostAttachment[];
  repostOf?: RepostOf;
  /** People mentioned, sent as `m.mentions.user_ids`: what notifies them (the spec's
   *  `.m.rule.is_user_mention` matches any event type). Write-only; nothing reads it back. */
  mentions?: string[];
  /** A content warning: the text and media stay hidden behind it until the reader asks. */
  warning?: string;
  /** The media is sensitive: shown blurred until the reader asks, even without a warning. */
  sensitive?: boolean;
};

/** Custom content keys. Namespaced, since `xyz.nekous.post` content is otherwise message-shaped. */
const ATTACHMENTS_KEY = 'xyz.nekous.attachments';
const REPOST_KEY = 'xyz.nekous.repost_of';
const WARNING_KEY = 'xyz.nekous.content_warning';
const SENSITIVE_KEY = 'xyz.nekous.sensitive';

/** The longest a post or comment may be, in characters — a microblog's usual cap (Mastodon's).
 *  Checked by the composers; nothing server-side enforces it. */
export const POST_MAX_LENGTH = 500;

/** Characters as a person counts them: an emoji is one, not the two UTF-16 units `length` says. */
export function postLength(text: string): number {
  return [...text].length;
}

export type PrivatePost = {
  id: string;
  spaceId: string;
  body: string;
  createdAt: number;
  attachments?: PostAttachment[];
};

/**
 * Servers to join a feed room through. From room version 12 a room ID carries no server name
 * (`!abc…`, no `:server`) — Continuwuity creates v12 rooms — so the room ID alone can give an
 * empty `via`, which the server rejects outright. The feed's owner is always in their own feed
 * room, and a user ID always names their server, so that's the one that's always there.
 */
export function feedJoinVia(roomId: string, ownerId: string): string[] {
  return [...new Set([serverNameOf(ownerId), serverNameOf(roomId)].filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Reading posts
// ---------------------------------------------------------------------------

export function isPostEvent(event: MatrixEvent): boolean {
  return event.getType() === POST_EVENT_TYPE && !event.isRedacted() && !editTargetOf(event);
}

/**
 * Editing a post is a standard `m.replace` of the same event type, so it's gated exactly like
 * posting (power level 100 in the feed room: the owner only) and any client that understands
 * edits understands it. The edit carries the whole new content under `m.new_content`, attachments
 * and repost included, so the edited post reads exactly like one sent that way.
 *
 * Edits are applied here rather than left to the SDK: the global feed reads feeds it hasn't joined
 * over plain `/messages`, where nothing aggregates them.
 */
export function editTargetOf(event: MatrixEvent): string | undefined {
  if (event.getType() !== POST_EVENT_TYPE) return undefined;
  const relation = event.getWireContent()['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined;
  return relation?.rel_type === RelationType.Replace && typeof relation.event_id === 'string' ? relation.event_id : undefined;
}

/**
 * Applies the newest valid edit among `candidates` to each post: by the post's own sender (anyone
 * else's "edit" is ignored, whatever the power levels say), not redacted, and newer than any edit
 * already applied. Mutates the events, the same way the SDK applies edits to a live timeline.
 * Returns whether anything changed.
 */
export function applyPostEdits(posts: MatrixEvent[], candidates: MatrixEvent[]): boolean {
  const byTarget = new Map<string, MatrixEvent>();
  candidates.forEach((edit) => {
    const target = editTargetOf(edit);
    if (!target || edit.isRedacted()) return;
    const best = byTarget.get(target);
    if (!best || edit.getTs() > best.getTs()) byTarget.set(target, edit);
  });
  let changed = false;
  posts.forEach((post) => {
    const edit = byTarget.get(post.getId() ?? '');
    if (!edit || edit.getSender() !== post.getSender() || post.isRedacted()) return;
    const current = post.replacingEvent();
    if (current && (current.getId() === edit.getId() || current.getTs() >= edit.getTs())) return;
    post.makeReplaced(edit);
    changed = true;
  });
  return changed;
}

export async function editPost(mx: MatrixClient, feedRoomId: string, eventId: string, content: PostContent): Promise<void> {
  const newContent = toEventContent(content);
  await mx.sendEvent(feedRoomId, POST_EVENT_TYPE as any, {
    ...newContent,
    'm.new_content': newContent,
    'm.relates_to': { rel_type: RelationType.Replace, event_id: eventId },
  } as any);
}

function readOrigin(raw: unknown): PostOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const origin = raw as Record<string, unknown>;
  if (origin.kind === 'global') return { kind: 'global' };
  if (origin.kind === 'space' && typeof origin.spaceId === 'string') {
    return { kind: 'space', spaceId: origin.spaceId, spaceName: typeof origin.spaceName === 'string' ? origin.spaceName : origin.spaceId };
  }
  return undefined;
}

function readRepostOf(raw: unknown): RepostOf | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const origin = readOrigin(r.origin);
  if (typeof r.roomId !== 'string' || typeof r.eventId !== 'string' || typeof r.sender !== 'string' || !origin) {
    return undefined;
  }
  const attachments = readAttachments(r.attachments);
  const body = typeof r.body === 'string' ? r.body : '';
  if (!body && attachments.length === 0) return undefined;
  return {
    roomId: r.roomId,
    eventId: r.eventId,
    sender: r.sender,
    senderName: typeof r.senderName === 'string' && r.senderName ? r.senderName : r.sender,
    origin,
    ts: typeof r.ts === 'number' ? r.ts : 0,
    body,
    ...(attachments.length && { attachments }),
    ...(typeof r.warning === 'string' && r.warning.trim() && { warning: r.warning.trim() }),
    ...(r.sensitive === true && { sensitive: true }),
  };
}

/**
 * A post's content, or undefined for an event that isn't one (or was redacted to nothing). A post
 * needs *something* to show: text, media, or a repost — a media-only post has an empty body.
 */
export function readPost(event: MatrixEvent): PostContent | undefined {
  if (!isPostEvent(event)) return undefined;
  return readPostContent(event.getContent<Record<string, unknown>>());
}

/** readPost's parsing on raw event content — shared with comments (postInteractions.ts), which
 *  carry the same text-and-media shape under a different event type. */
export function readPostContent(content: Record<string, unknown>): PostContent | undefined {
  const body = typeof content.body === 'string' ? content.body : '';
  const attachments = readAttachments(content[ATTACHMENTS_KEY]);
  const repostOf = readRepostOf(content[REPOST_KEY]);
  if (!body && attachments.length === 0 && !repostOf) return undefined;
  const warning = typeof content[WARNING_KEY] === 'string' ? (content[WARNING_KEY] as string).trim() : '';
  return {
    body,
    ...(typeof content.format === 'string' && content.format && { format: content.format }),
    ...(typeof content.formatted_body === 'string' && content.formatted_body && { formatted_body: content.formatted_body }),
    ...(attachments.length && { attachments }),
    ...(repostOf && { repostOf }),
    ...(warning && { warning }),
    ...(content[SENSITIVE_KEY] === true && { sensitive: true }),
  };
}

export function buildPostContent(
  body: string,
  formattedBody?: string,
  extras: { attachments?: PostAttachment[]; repostOf?: RepostOf; mentions?: string[]; warning?: string; sensitive?: boolean } = {}
): PostContent {
  const warning = extras.warning?.trim();
  return {
    body,
    ...(formattedBody && { format: 'org.matrix.custom.html', formatted_body: formattedBody }),
    ...(extras.attachments?.length && { attachments: extras.attachments }),
    ...(extras.repostOf && { repostOf: extras.repostOf }),
    ...(extras.mentions?.length && { mentions: extras.mentions }),
    ...(warning && { warning }),
    // Only meaningful with media to cover.
    ...(extras.sensitive && extras.attachments?.length && { sensitive: true }),
  };
}

/** PostContent → the event content actually sent (the custom fields under namespaced keys). */
export function toEventContent(content: PostContent): Record<string, unknown> {
  const { attachments, repostOf, mentions, warning, sensitive, ...message } = content;
  return {
    ...message,
    ...(attachments?.length && { [ATTACHMENTS_KEY]: attachments }),
    ...(repostOf && { [REPOST_KEY]: repostOf }),
    ...(mentions?.length && { 'm.mentions': { user_ids: mentions } }),
    ...(warning && { [WARNING_KEY]: warning }),
    ...(sensitive && { [SENSITIVE_KEY]: true }),
  };
}

/**
 * The embedded copy for reposting a post. Reposting a bare repost (no comment of its own) reposts
 * the original instead — "reposted a repost of X" says nothing "reposted X" doesn't, and
 * flattening keeps reposts exactly one level deep.
 */
export function repostOfPost(
  post: { roomId: string; eventId: string; sender: string; senderName: string; origin: PostOrigin; ts: number },
  content: PostContent
): RepostOf {
  if (content.repostOf && !content.body && !content.attachments?.length) return content.repostOf;
  return {
    roomId: post.roomId,
    eventId: post.eventId,
    sender: post.sender,
    senderName: post.senderName,
    origin: post.origin,
    ts: post.ts,
    body: content.body,
    ...(content.attachments?.length && { attachments: content.attachments }),
    ...(content.warning && { warning: content.warning }),
    ...(content.sensitive && { sensitive: true }),
  };
}

/**
 * Reposting only moves content between public places: from your or anyone's global feed, or a
 * public Space, into your global feed or a public Space. Copying a post out of a private Space
 * — even into another private one — would hand it to people its author never posted it for.
 *
 * The one exception is a repost that stays **inside the same Space**: its audience is exactly the
 * audience the original already had (that Space's members), so nothing becomes more visible.
 */
export function canRepost(source: PostOrigin, sourceIsPublic: boolean, target: PostOrigin, targetIsPublic: boolean): boolean {
  if (source.kind === 'space' && target.kind === 'space' && source.spaceId === target.spaceId) return true;
  const sourceOk = source.kind === 'global' || sourceIsPublic;
  const targetOk = target.kind === 'global' || targetIsPublic;
  return sourceOk && targetOk;
}

/** Whose feed this room is, from the room's own state — undefined for any other kind of room. */
export function readFeedOwner(room: Room): string | undefined {
  const content = room.currentState.getStateEvents(FEED_MARKER_EVENT, '')?.getContent<{ owner?: string }>();
  return typeof content?.owner === 'string' ? content.owner : undefined;
}

// ---------------------------------------------------------------------------
// Finding feeds
// ---------------------------------------------------------------------------

/** The feed room a given member publishes in this Space, if they have one yet. */
export function readFeedRoomId(space: Room, userId: string): string | undefined {
  const content = space.currentState.getStateEvents(EventType.RoomMember, userId)?.getContent() as
    | Record<string, unknown>
    | undefined;
  const roomId = content?.[FEED_ROOM_MEMBER_KEY];
  return typeof roomId === 'string' && roomId ? roomId : undefined;
}

/**
 * Every feed in the Space, from already-synced member state. Only joined members count — someone
 * who left takes their timeline out of the hub with them, without anything having to be cleaned
 * up when they go.
 */
export function listSpaceFeeds(space: Room): { userId: string; roomId: string }[] {
  const memberEvents = space.currentState.getStateEvents(EventType.RoomMember) as MatrixEvent[];
  const feeds: { userId: string; roomId: string }[] = [];
  memberEvents.forEach((event) => {
    const content = event.getContent() as Record<string, unknown>;
    if (content.membership !== 'join') return;
    const roomId = content[FEED_ROOM_MEMBER_KEY];
    const userId = event.getStateKey();
    if (typeof roomId === 'string' && roomId && userId) feeds.push({ userId, roomId });
  });
  return feeds;
}

function readOwnFeedRooms(mx: MatrixClient): Record<string, string> {
  return mx.getAccountData(FEED_ROOMS_ACCOUNT_DATA as any)?.getContent<Record<string, string>>() ?? {};
}

export function getOwnFeedRoomId(mx: MatrixClient, spaceId: string): string | undefined {
  return readOwnFeedRooms(mx)[spaceId];
}

/** Every Space feed room you own, from your own record of them. */
export function listOwnFeedRoomIds(mx: MatrixClient): string[] {
  return listOwnFeedRooms(mx).map(({ roomId }) => roomId);
}

/** Every Space feed room you own, with the Space it belongs to. */
export function listOwnFeedRooms(mx: MatrixClient): { spaceId: string; roomId: string }[] {
  return Object.entries(readOwnFeedRooms(mx))
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1])
    .map(([spaceId, roomId]) => ({ spaceId, roomId }));
}

/** Whose feed a room is and where it belongs, from its marker — for anything holding just a room
 *  (a notification, say) that needs to open the posts view rather than treat it as a channel. */
export function readFeedMarker(room: Room): { owner: string; spaceId?: string; profile: boolean } | undefined {
  const content = room.currentState.getStateEvents(FEED_MARKER_EVENT, '')?.getContent<Record<string, unknown>>();
  if (typeof content?.owner !== 'string') return undefined;
  return {
    owner: content.owner,
    ...(typeof content.spaceId === 'string' && { spaceId: content.spaceId }),
    profile: content.profile === true,
  };
}

// ---------------------------------------------------------------------------
// Creating a feed
// ---------------------------------------------------------------------------

/**
 * Publishes (or re-publishes) the pointer to your feed room on your own member event, preserving
 * everything else in it — your per-Space nickname lives in the same content, and a write that
 * dropped it would silently rename you.
 *
 * Re-publishing is routine, not a one-off: a homeserver rewrites your member event in every room
 * when you change your profile, and Continuwuity writes it fresh, without the pointer (verified
 * live). FeedGovernance calls this again whenever that happens.
 */
export async function publishFeedPointer(mx: MatrixClient, space: Room, roomId: string): Promise<void> {
  const myUserId = mx.getUserId();
  if (!myUserId) return;
  const synced = (space.currentState.getStateEvents(EventType.RoomMember, myUserId)?.getContent() ??
    {}) as Record<string, unknown>;
  if (synced[FEED_ROOM_MEMBER_KEY] === roomId && hasText(synced.displayname)) return;

  // The server's copy, not the synced one: right after a profile change the synced copy still has
  // the old name (or none, if this client never loaded it), and writing it back would undo the
  // change.
  const current = ((await mx.getStateEvent(space.roomId, EventType.RoomMember, myUserId).catch(() => undefined)) ??
    synced) as Record<string, unknown>;
  const content: Record<string, unknown> = { ...current, membership: 'join', [FEED_ROOM_MEMBER_KEY]: roomId };
  // A member event without a name shows its owner as their bare user ID everywhere in the Space.
  if (!hasText(content.displayname)) {
    const profile = await mx.getProfileInfo(myUserId).catch(() => undefined);
    if (hasText(profile?.displayname)) content.displayname = profile.displayname;
    if (!hasText(content.avatar_url) && hasText(profile?.avatar_url)) content.avatar_url = profile.avatar_url;
  }
  if (current[FEED_ROOM_MEMBER_KEY] === roomId && content.displayname === current.displayname) return;
  await mx.sendStateEvent(space.roomId, EventType.RoomMember, content as any, myUserId);
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Creates the room a feed lives in. Not routed through `roomCreation.ts`'s `createRoom` on
 * purpose: a feed room isn't a channel and doesn't want any of that function's policy — it is
 * never a Space child (nothing should list it in the channel list, and an ordinary member can't
 * write `m.space.child` anyway), it needs `world_readable` history, and its power levels gate a
 * custom event type. Bending the channel helper to cover all three would make every channel's
 * creation path carry feed-shaped options.
 */
/**
 * Who can read a feed room's posts. A **public** Space's feeds are world-readable, which is what
 * lets the global feed show them to people outside the Space. Every other Space's feeds are
 * members-only (`shared`): readable once you've joined the feed room, and only a member of the
 * Space can join (the restricted join rule below). That's the whole of what keeps a private
 * Space's posts private: Matrix has no per-event visibility, so the room decides.
 *
 * `shared` rather than `joined`: someone who joins the Space later can still read what was posted
 * before they arrived, the same as scrolling back in a channel.
 */
export function feedHistoryVisibility(isPublic: boolean): HistoryVisibility {
  return isPublic ? HistoryVisibility.WorldReadable : HistoryVisibility.Shared;
}

/**
 * Brings an existing feed room's visibility in line with its Space, since a Space can be made
 * public or private after its feeds exist. History visibility applies to events from the moment
 * it's set, so this protects every post from now on — posts sent while the room was
 * world-readable stay readable (see docs/posts.md, "Private Spaces").
 */
export async function syncFeedVisibility(mx: MatrixClient, roomId: string, isPublic: boolean): Promise<void> {
  const current = mx
    .getRoom(roomId)
    ?.currentState?.getStateEvents(EventType.RoomHistoryVisibility, '')
    ?.getContent<{ history_visibility?: string }>().history_visibility;
  const wanted = feedHistoryVisibility(isPublic);
  if (current && current !== wanted) {
    await mx.sendStateEvent(roomId, EventType.RoomHistoryVisibility, { history_visibility: wanted }, '');
  }
}

async function createFeedRoom(mx: MatrixClient, space: Room, displayName: string, isPublic: boolean): Promise<string> {
  const { room_id: roomId } = await mx.createRoom({
    name: `${displayName}'s posts`,
    // Never in the public directory: a feed is discovered through its owner's membership of the
    // Space, and listing it would make it findable by people who aren't in the hub at all.
    visibility: Visibility.Private,
    power_level_content_override: {
      // Only the owner (power level 100 as the room's creator) can post. Everything else stays
      // at the default, so other members can still react — `events_default` is untouched.
      events: { [POST_EVENT_TYPE]: 100 },
    },
    initial_state: [
      {
        // Membership of the Space is what grants access, the same rule voice channels use. It
        // is also what lets other members join this room to read and react without the owner
        // having to invite every one of them.
        type: EventType.RoomJoinRules,
        state_key: '',
        content: {
          join_rule: JoinRule.Restricted,
          allow: [{ type: RestrictedAllowType.RoomMembership, room_id: space.roomId }],
        },
      },
      {
        // World-readable only for a public Space; members-only otherwise (feedHistoryVisibility).
        type: EventType.RoomHistoryVisibility,
        state_key: '',
        content: { history_visibility: feedHistoryVisibility(isPublic) },
      },
      channelTypeInitialStateEvent('feed'),
      { type: FEED_MARKER_EVENT, state_key: '', content: { owner: mx.getUserId(), spaceId: space.roomId } },
    ],
  });
  return roomId;
}

/**
 * Whether you're in a room you created as a feed, rejoining it if you'd somehow left (or this
 * client simply hasn't got it yet). Creating a fresh feed whenever the known one wasn't joined at
 * that instant would strand every post in the old one and repoint everything at an empty room, so
 * a new feed is only made when the old one really can't be got back into.
 */
export async function rejoinOwnRoom(mx: MatrixClient, roomId: string): Promise<boolean> {
  if (mx.getRoom(roomId)?.getMyMembership() === 'join') return true;
  try {
    await mx.joinRoom(roomId, { viaServers: feedJoinVia(roomId, mx.getUserId() ?? '') });
    return true;
  } catch {
    return false;
  }
}

/**
 * The feed room to post into, creating it on first use. Returns an existing one whenever there
 * is one — checking the author's own account data before their published pointer, since the
 * account data is what survives a leave-and-rejoin of the Space.
 *
 * `isPublic` is whether the Space is listed (public). It defaults to false — members-only — so a
 * caller that doesn't know never exposes a private Space's posts.
 */
export async function ensureFeedRoom(mx: MatrixClient, space: Room, displayName: string, isPublic = false): Promise<string> {
  const myUserId = mx.getUserId() ?? '';
  const known = getOwnFeedRoomId(mx, space.roomId) ?? readFeedRoomId(space, myUserId);
  if (known && (await rejoinOwnRoom(mx, known))) {
    await syncFeedVisibility(mx, known, isPublic);
    await publishFeedPointer(mx, space, known);
    return known;
  }

  const roomId = await createFeedRoom(mx, space, displayName, isPublic);
  const current = (await readFreshAccountData<Record<string, string>>(mx, FEED_ROOMS_ACCOUNT_DATA)) ?? {};
  await mx.setAccountData(FEED_ROOMS_ACCOUNT_DATA as any, { ...current, [space.roomId]: roomId } as any);
  await publishFeedPointer(mx, space, roomId);
  return roomId;
}

/**
 * Joins the feed rooms of everyone in the Space that this client isn't in yet, which is what
 * makes the hub view able to show them: a private Space's feeds can only be read by joining, and
 * even a world-readable one would otherwise need a peek, the least well-supported corner of the
 * Matrix client-server API. Joining
 * is allowed without an invite because feed rooms are restricted to the Space.
 *
 * Failures are per-room and ignored — one member's feed being unjoinable (a server that's down,
 * a room they've since locked) is not a reason for the rest of the hub to stay empty.
 */
export async function followSpaceFeeds(mx: MatrixClient, space: Room): Promise<void> {
  await space.loadMembersIfNeeded();
  const feeds = listSpaceFeeds(space);
  await Promise.all(
    feeds
      .filter(({ roomId }) => mx.getRoom(roomId)?.getMyMembership() !== 'join')
      .map(({ roomId, userId }) =>
        mx.joinRoom(roomId, { viaServers: feedJoinVia(roomId, userId) }).catch(() => undefined)
      )
  );
}

// ---------------------------------------------------------------------------
// Publishing, unpublishing, deleting
// ---------------------------------------------------------------------------

/** Sends a post and hands back its event ID. */
export async function publishPost(mx: MatrixClient, feedRoomId: string, content: PostContent): Promise<string> {
  const { event_id: eventId } = await mx.sendEvent(feedRoomId, POST_EVENT_TYPE as any, toEventContent(content) as any);
  return eventId;
}

/** Deleting a public post is an ordinary redaction — the author is power level 100 in their own
 *  feed room, so no moderation permission is involved. */
export async function deletePost(mx: MatrixClient, feedRoomId: string, eventId: string): Promise<void> {
  await mx.redactEvent(feedRoomId, eventId);
}

// ---------------------------------------------------------------------------
// Private posts
// ---------------------------------------------------------------------------

function newPrivatePostId(): string {
  return `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function readPrivatePosts(mx: MatrixClient, spaceId?: string): PrivatePost[] {
  const content = mx
    .getAccountData(PRIVATE_POSTS_ACCOUNT_DATA as any)
    ?.getContent<{ items?: PrivatePost[] }>();
  const items = content?.items ?? [];
  const scoped = spaceId ? items.filter((item) => item.spaceId === spaceId) : items;
  return [...scoped].sort((a, b) => b.createdAt - a.createdAt);
}

/** Changes the private-post list as the server has it now (freshAccountData.ts), so a post saved
 *  from another device a moment ago isn't overwritten. */
async function updatePrivatePosts(mx: MatrixClient, change: (items: PrivatePost[]) => PrivatePost[]): Promise<void> {
  const current = await readFreshAccountData<{ items?: PrivatePost[] }>(mx, PRIVATE_POSTS_ACCOUNT_DATA);
  const items = Array.isArray(current?.items) ? current.items : [];
  await mx.setAccountData(PRIVATE_POSTS_ACCOUNT_DATA as any, { items: change(items) } as any);
}

export async function savePrivatePost(
  mx: MatrixClient,
  spaceId: string,
  body: string,
  attachments: PostAttachment[] = []
): Promise<PrivatePost> {
  const post: PrivatePost = {
    id: newPrivatePostId(),
    spaceId,
    body,
    createdAt: Date.now(),
    ...(attachments.length && { attachments }),
  };
  await updatePrivatePosts(mx, (items) => [...items, post]);
  return post;
}

export async function deletePrivatePost(mx: MatrixClient, id: string): Promise<void> {
  await updatePrivatePosts(mx, (items) => items.filter((post) => post.id !== id));
}

/**
 * Takes a published post back out of view: redact it, then keep the text privately. Redaction
 * first, deliberately — if the account-data write fails the post is still unpublished, which is
 * what was actually asked for, whereas the other order could leave it visible with the author
 * believing otherwise.
 */
export async function makePostPrivate(
  mx: MatrixClient,
  spaceId: string,
  feedRoomId: string,
  event: MatrixEvent
): Promise<void> {
  const post = readPost(event);
  await mx.redactEvent(feedRoomId, event.getId() ?? '');
  if (post) await savePrivatePost(mx, spaceId, post.body, post.attachments);
}

/** Publishes a private post and drops the private copy. Same ordering logic in reverse: nothing
 *  is removed from account data until it is definitely somewhere else. */
export async function publishPrivatePost(
  mx: MatrixClient,
  feedRoomId: string,
  post: PrivatePost,
  content: PostContent
): Promise<void> {
  await publishPost(mx, feedRoomId, content);
  await deletePrivatePost(mx, post.id);
}

import { Direction, EventType, Method, RelationType, type MatrixClient } from 'matrix-js-sdk';
import { feedJoinVia, readPostContent, toEventContent, type PostContent } from './feed';

/**
 * Likes and comments on posts — both live in the post's own feed room, related to the post.
 *
 * - **A like** is an ordinary `m.reaction` with the ❤️ key, so any Matrix client sees it as a
 *   heart reaction. Un-liking redacts it.
 * - **A comment** is `xyz.nekous.comment`: post-shaped content (text, formatting, media — the same
 *   `readPostContent`/`toEventContent` as a post) with an `m.reference` relation to the post. Its
 *   own event type for the same reasons a post has one (feed.ts): it notifies nobody by default,
 *   and a feed room peeked from another client shows no chat log. The thread is flat; a comment can
 *   answer another comment (`xyz.nekous.reply_to`), and then it also names that comment's author
 *   in `m.mentions` — which is what notifies them: the spec's built-in `.m.rule.is_user_mention`
 *   rule matches `m.mentions` on any event type, custom ones included (checked on Continuwuity:
 *   a reply to Bob reaches Bob's push gateway, a plain comment beside it doesn't). Only the person
 *   replied to is notified, never everyone in the thread. Feed rooms leave `events_default` alone,
 *   so anyone who has joined the room can comment; only posting is gated.
 *
 * **Reading** needs no membership: `/relations` answers a non-member for a world-readable feed
 * (Global, public Spaces) — checked against Continuwuity. Likes and comments are read separately
 * (filtered by relation and event type), so that a thread of any length stays cheap:
 *
 * - **Comments** come newest first, a page at a time: a card reads one page, and older pages are
 *   fetched only when someone scrolls back to them. Nothing is dropped; it's just not read yet.
 * - **Likes** are read to the end, up to a cap, and reported as "1000+" past it. They're small
 *   events, but a hugely-liked post shouldn't hold its card up for dozens of requests.
 *
 * **Why older pages don't use `/relations` tokens.** Continuwuity's `/relations` pages backwards
 * wrong: its `next_batch` steps back one event instead of one page (asking for 50 at a time over
 * a 130-comment thread returns 130–81, then 129–80, then 128–79…), it caps a page at 100 whatever
 * the `limit`, and paging forwards returns nothing. Its first page is right, though, so that's
 * all this reads from `/relations`. Anything older comes from the room's own timeline instead:
 * `/context` gives a position just before the oldest relation loaded, and `/messages` pages
 * backwards from there filtered to the one event type — pagination every client relies on, and
 * checked to walk the same 130-comment thread 80–51, 50–21, 20–1 exactly. It stops at the post,
 * since nothing can relate to a post from before it existed. Standard endpoints only, so it works
 * the same on Synapse. **Writing** needs membership, so liking or commenting joins the feed room
 * first (anyone for a profile feed; only that Space's members for a Space feed, by its restricted
 * join rule).
 *
 * A redacted like or comment still comes back from `/relations` — with empty content and
 * `unsigned.redacted_because` — so everything below counts only relations that still carry their
 * `m.relates_to`.
 */
export const COMMENT_EVENT_TYPE = 'xyz.nekous.comment';
export const LIKE_KEY = '❤️';
const REPLY_TO_KEY = 'xyz.nekous.reply_to';

/**
 * A repost's marker on the original. The repost itself lives in the reposter's own feed (feed.ts),
 * which the original's author may never read, so reposting also drops this small event into the
 * *original's* room, related to the post like a like is. It's what counts reposts, what tells the
 * author (activity.ts), and what knows you've reposted something so the button can undo it. It
 * names the repost it stands for, so undoing deletes both.
 *
 * Best-effort: sending it needs membership of the original's room, which a Space feed only allows
 * that Space's members. A public Space's post reposted by an outsider has no marker, so it isn't
 * counted — the repost itself still goes out.
 */
export const REPOST_RECEIPT_TYPE = 'xyz.nekous.repost';
const REPOST_RECEIPT_KEY = 'xyz.nekous.repost_event';

/** The comment a reply answers, and who wrote it. */
export type ReplyTarget = { eventId: string; sender: string };

export type PostComment = { eventId: string; sender: string; ts: number; content: PostContent; replyTo?: ReplyTarget };

function readReplyTo(raw: unknown): ReplyTarget | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return typeof r.event_id === 'string' && typeof r.sender === 'string' ? { eventId: r.event_id, sender: r.sender } : undefined;
}

export type PostInteractions = {
  likeCount: number;
  /** Who liked it, in the order read (newest first). */
  likers: string[];
  /** Your own like's event ID — what un-liking redacts. */
  myLikeId?: string;
  /** Oldest first. */
  comments: PostComment[];
};

/** The slice of a raw event summarizeRelations reads. */
export type RawRelationEvent = {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: { redacted_because?: unknown };
};

/** Comments per page: what a card reads up front, and what each "load earlier" fetches. */
export const COMMENT_PAGE_SIZE = 50;
/** Likes are read 100 at a time, up to this many pages; past it the count shows as "1000+". */
const MAX_LIKE_PAGES = 10;
/** Timeline pages one "load earlier" may read looking for older comments. In a busy feed most
 *  comments belong to other posts; this bounds the search, and the next click carries on. */
const MAX_TIMELINE_PAGES = 10;
const TIMELINE_PAGE_SIZE = 100;

/** Where to carry on reading older relations: just before an event (resolved to a timeline
 *  position with /context), or a timeline token from the previous read. */
export type OlderCursor = { beforeEventId: string } | { token: string };

type MessagesResponse = { chunk: RawRelationEvent[]; end?: string };

/**
 * Reads the room timeline backwards from `cursor`, filtered to one event type, collecting events
 * that relate to `postId` until it has `want` of them, reaches the post, or runs out of pages.
 * Hands back a cursor to carry on from — absent once there's nothing older.
 */
async function readOlderRelations(
  mx: MatrixClient,
  roomId: string,
  postId: string,
  eventType: string,
  cursor: OlderCursor,
  { want, postTs }: { want: number; postTs: number }
): Promise<{ events: RawRelationEvent[]; next?: OlderCursor }> {
  const room = encodeURIComponent(roomId);
  let token: string | undefined;
  if ('token' in cursor) {
    token = cursor.token;
  } else {
    const context = await mx.http.authedRequest<{ start?: string }>(
      Method.Get,
      `/rooms/${room}/context/${encodeURIComponent(cursor.beforeEventId)}`,
      { limit: '0' }
    );
    token = context.start;
  }

  const found: RawRelationEvent[] = [];
  const filter = JSON.stringify({ types: [eventType] });
  for (let page = 0; page < MAX_TIMELINE_PAGES && token; page += 1) {
    const res = await mx.http.authedRequest<MessagesResponse>(Method.Get, `/rooms/${room}/messages`, {
      dir: Direction.Backward,
      from: token,
      limit: String(TIMELINE_PAGE_SIZE),
      filter,
    });
    // Only this post's relations; summarizeRelations drops anything redacted or unrelated anyway.
    found.push(
      ...res.chunk.filter(
        (event) => (event.content['m.relates_to'] as { event_id?: string } | undefined)?.event_id === postId
      )
    );
    const reachedPost = res.chunk.some((event) => event.origin_server_ts < postTs);
    token = res.chunk.length > 0 && !reachedPost ? res.end : undefined;
    if (found.length >= want) break;
  }
  return { events: found, ...(token && { next: { token } }) };
}

function relatesTo(event: RawRelationEvent, postId: string, relType: string): boolean {
  if (event.unsigned?.redacted_because) return false;
  const relation = event.content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined;
  return relation?.rel_type === relType && relation.event_id === postId;
}

/** Likes and comments out of a post's raw relations. Pure, so it's tested without a server. */
export function summarizeRelations(events: RawRelationEvent[], postId: string, myUserId: string): PostInteractions {
  // One like per person, however many reactions they've managed to send (two devices, a race).
  const likers = new Map<string, string>();
  const comments: PostComment[] = [];

  for (const event of events) {
    if (event.type === EventType.Reaction && relatesTo(event, postId, RelationType.Annotation)) {
      const key = (event.content['m.relates_to'] as { key?: unknown }).key;
      if (key === LIKE_KEY && !likers.has(event.sender)) likers.set(event.sender, event.event_id);
    } else if (event.type === COMMENT_EVENT_TYPE && relatesTo(event, postId, RelationType.Reference)) {
      const content = readPostContent(event.content);
      // A comment can't embed a repost; only text and media are read from it.
      if (content) {
        const { repostOf: _ignored, ...rest } = content;
        const replyTo = readReplyTo(event.content[REPLY_TO_KEY]);
        comments.push({
          eventId: event.event_id,
          sender: event.sender,
          ts: event.origin_server_ts,
          content: rest,
          ...(replyTo && { replyTo }),
        });
      }
    }
  }

  comments.sort((a, b) => a.ts - b.ts);
  return { likeCount: likers.size, likers: [...likers.keys()], myLikeId: likers.get(myUserId), comments };
}

export type LikeSummary = {
  likeCount: number;
  likers: string[];
  myLikeId?: string;
  /** More likes exist than were counted. */
  likesTruncated: boolean;
};

export async function fetchLikes(mx: MatrixClient, roomId: string, postId: string, postTs: number): Promise<LikeSummary> {
  const first = await mx.fetchRelations(roomId, postId, RelationType.Annotation, EventType.Reaction, { limit: 100 });
  const events = [...(first.chunk as unknown as RawRelationEvent[])];
  let next: OlderCursor | undefined =
    first.next_batch && events.length ? { beforeEventId: events[events.length - 1].event_id } : undefined;
  for (let round = 1; round < MAX_LIKE_PAGES && next; round += 1) {
    const older = await readOlderRelations(mx, roomId, postId, EventType.Reaction, next, { want: 100, postTs });
    events.push(...older.events);
    next = older.next;
  }
  const { likeCount, likers, myLikeId } = summarizeRelations(events, postId, mx.getUserId() ?? '');
  return { likeCount, likers, myLikeId, likesTruncated: !!next };
}

/** Your own marker, and the repost it stands for — what undoing a repost deletes. */
export type MyRepost = { receiptId: string; roomId: string; eventId: string };

export type RepostSummary = {
  /** People who reposted it (one each, however many times). */
  repostCount: number;
  repostsTruncated: boolean;
  mine?: MyRepost;
};

/** Repost markers out of a post's raw relations. Pure, so it's tested without a server. */
export function summarizeReposts(events: RawRelationEvent[], postId: string, myUserId: string): Omit<RepostSummary, 'repostsTruncated'> {
  const reposters = new Set<string>();
  let mine: MyRepost | undefined;
  for (const event of events) {
    if (event.type !== REPOST_RECEIPT_TYPE || !relatesTo(event, postId, RelationType.Reference)) continue;
    reposters.add(event.sender);
    const target = event.content[REPOST_RECEIPT_KEY] as { room_id?: unknown; event_id?: unknown } | undefined;
    if (!mine && event.sender === myUserId && typeof target?.room_id === 'string' && typeof target.event_id === 'string') {
      mine = { receiptId: event.event_id, roomId: target.room_id, eventId: target.event_id };
    }
  }
  return { repostCount: reposters.size, ...(mine && { mine }) };
}

/** One page of markers is plenty: past it the count reads "100+". */
export async function fetchReposts(mx: MatrixClient, roomId: string, postId: string): Promise<RepostSummary> {
  const res = await mx.fetchRelations(roomId, postId, RelationType.Reference, REPOST_RECEIPT_TYPE, { limit: 100 });
  const chunk = res.chunk as unknown as RawRelationEvent[];
  return { ...summarizeReposts(chunk, postId, mx.getUserId() ?? ''), repostsTruncated: !!res.next_batch && chunk.length > 0 };
}

export async function sendRepostReceipt(
  mx: MatrixClient,
  roomId: string,
  postId: string,
  ownerId: string,
  repost: { roomId: string; eventId: string; quote: boolean }
): Promise<void> {
  await ensureJoined(mx, roomId, ownerId);
  await mx.sendEvent(roomId, REPOST_RECEIPT_TYPE as any, {
    [REPOST_RECEIPT_KEY]: { room_id: repost.roomId, event_id: repost.eventId, quote: repost.quote },
    'm.relates_to': { rel_type: RelationType.Reference, event_id: postId },
  } as any);
}

export type CommentPage = {
  /** Oldest first, like the thread shows them. */
  comments: PostComment[];
  /** Where older comments carry on from; absent once the oldest has been read. */
  older?: OlderCursor;
};

/** The newest page of comments — the one `/relations` page that's reliable everywhere. */
export async function fetchComments(mx: MatrixClient, roomId: string, postId: string): Promise<CommentPage> {
  const res = await mx.fetchRelations(roomId, postId, RelationType.Reference, COMMENT_EVENT_TYPE, {
    dir: Direction.Backward,
    limit: COMMENT_PAGE_SIZE,
  });
  const chunk = res.chunk as unknown as RawRelationEvent[];
  const { comments } = summarizeRelations(chunk, postId, '');
  const more = !!res.next_batch && chunk.length > 0;
  return { comments, ...(more && { older: { beforeEventId: chunk[chunk.length - 1].event_id } }) };
}

/** The page of comments before `cursor` (a previous page's `older`), from the room timeline. */
export async function fetchOlderComments(
  mx: MatrixClient,
  roomId: string,
  postId: string,
  cursor: OlderCursor,
  postTs: number
): Promise<CommentPage> {
  const { events, next } = await readOlderRelations(mx, roomId, postId, COMMENT_EVENT_TYPE, cursor, {
    want: COMMENT_PAGE_SIZE,
    postTs,
  });
  const { comments } = summarizeRelations(events, postId, '');
  return { comments, ...(next && { older: next }) };
}

/**
 * Folds a freshly-read newest page into the comments already loaded. Anything the fresh page
 * covers is replaced by it — so a comment deleted within that span disappears — while older
 * comments loaded earlier (by "load earlier") are kept as they were.
 */
export function mergeNewestPage(loaded: PostComment[], fresh: PostComment[]): PostComment[] {
  if (fresh.length === 0) return [];
  const oldestFresh = fresh[0].ts;
  const older = loaded.filter((comment) => comment.ts < oldestFresh);
  return [...older, ...fresh];
}

/** Liking or commenting needs membership of the feed room; reading never did. `ownerId` is the
 *  feed's owner, whose server is always a working way in (feedJoinVia). */
async function ensureJoined(mx: MatrixClient, roomId: string, ownerId: string): Promise<void> {
  if (mx.getRoom(roomId)?.getMyMembership() === 'join') return;
  await mx.joinRoom(roomId, { viaServers: feedJoinVia(roomId, ownerId) });
}

export async function likePost(mx: MatrixClient, roomId: string, postId: string, ownerId: string): Promise<string> {
  await ensureJoined(mx, roomId, ownerId);
  const { event_id: eventId } = await mx.sendEvent(roomId, EventType.Reaction, {
    'm.relates_to': { rel_type: RelationType.Annotation, event_id: postId, key: LIKE_KEY },
  });
  return eventId;
}

export async function unlikePost(mx: MatrixClient, roomId: string, likeId: string): Promise<void> {
  await mx.redactEvent(roomId, likeId);
}

/**
 * A comment's event content. A reply also names the comment it answers and mentions its author —
 * unless that's you, since nobody needs telling they replied to themselves.
 */
export function buildCommentContent(
  postId: string,
  content: PostContent,
  { replyTo, myUserId }: { replyTo?: ReplyTarget; myUserId?: string } = {}
): Record<string, unknown> {
  const { repostOf: _ignored, mentions = [], ...commentContent } = content;
  // Whoever was picked from the autocomplete, plus the author of the comment being answered.
  const mentioned = [...new Set([...mentions, ...(replyTo ? [replyTo.sender] : [])])].filter((id) => id !== myUserId);
  return {
    ...toEventContent(commentContent),
    ...(replyTo && { [REPLY_TO_KEY]: { event_id: replyTo.eventId, sender: replyTo.sender } }),
    ...(mentioned.length > 0 && { 'm.mentions': { user_ids: mentioned } }),
    'm.relates_to': { rel_type: RelationType.Reference, event_id: postId },
  };
}

export async function sendComment(
  mx: MatrixClient,
  roomId: string,
  postId: string,
  ownerId: string,
  content: PostContent,
  replyTo?: ReplyTarget
): Promise<void> {
  await ensureJoined(mx, roomId, ownerId);
  const eventContent = buildCommentContent(postId, content, { replyTo, myUserId: mx.getUserId() ?? undefined });
  await mx.sendEvent(roomId, COMMENT_EVENT_TYPE as any, eventContent as any);
}

/** By its author, or by the feed's owner — power level 100 in their own feed room, which is
 *  enough to redact anyone's event there. */
export async function deleteComment(mx: MatrixClient, roomId: string, commentId: string): Promise<void> {
  await mx.redactEvent(roomId, commentId);
}

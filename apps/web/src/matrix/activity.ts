import { Direction, EventType, Method, RelationType, type MatrixClient } from 'matrix-js-sdk';
import { listOwnFeedRoomIds } from './feed';
import { readFreshAccountData } from './freshAccountData';
import { readMentionInbox } from './mentionInbox';
import { COMMENT_EVENT_TYPE, LIKE_KEY, REPOST_RECEIPT_TYPE } from './postInteractions';
import { FOLLOWED_EVENT, getOwnProfileRoomId } from './profileFeed';

/**
 * Activity — the global feed's notifications tab: likes, comments, replies, reposts and quotes of
 * your posts, new followers, and mentions of you in posts and comments.
 *
 * Nearly all of it is already delivered to you, because it lands in **your own feed rooms** (your
 * profile feed and your feed in each Space): a like, a comment, a repost marker
 * (postInteractions.ts) and a follow notice (profileFeed.ts) are all events in the room of the
 * post or profile they're about, and you're always in your own. So Activity is read straight from
 * those rooms' recent history — nothing extra to collect or store, and it's complete across
 * devices and time spent offline.
 *
 * The one thing that happens *elsewhere* is being mentioned or replied to under someone else's
 * post. Those come from the mention inbox (mentionInbox.ts), which already records every post and
 * comment that mentions you — and a reply always mentions whoever it answers.
 *
 * What you've seen is a timestamp in account data, so the unread dot clears on every device.
 */
export type ActivityKind = 'like' | 'comment' | 'reply' | 'mention' | 'repost' | 'quote' | 'follow';

export type ActivityItem = {
  /** Stable key: the event for a single item, the post (or day) for a grouped one. */
  key: string;
  kind: ActivityKind;
  /** Newest first, one entry each. */
  senders: string[];
  /** When the newest of it happened. */
  ts: number;
  /** The room the newest event is in, and the event: what a comment/reply/mention shows. */
  roomId: string;
  eventId: string;
  /** The post it's about — yours, or for a mention/reply, the post it's in or under. */
  postId?: string;
  /** A quote: the quoting post (it lives in the quoter's own feed). */
  quote?: { roomId: string; eventId: string };
};

export type RawActivityEvent = {
  event_id: string;
  room_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: { redacted_because?: unknown };
};

/** Likes and reposts of one post, and follows on one day, are one row each: "Ana and 3 others". */
const GROUPED: ActivityKind[] = ['like', 'repost', 'follow'];

type Classified = Omit<ActivityItem, 'key' | 'senders'> & { sender: string };

function relationOf(event: RawActivityEvent): { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined {
  return event.content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown; key?: unknown } | undefined;
}

/** One event from your own feed rooms, as activity — or undefined if it's none. */
function classify(event: RawActivityEvent, myUserId: string): Classified | undefined {
  if (event.sender === myUserId || event.unsigned?.redacted_because) return undefined;
  const base = { sender: event.sender, ts: event.origin_server_ts, roomId: event.room_id, eventId: event.event_id };
  const relation = relationOf(event);
  const postId = typeof relation?.event_id === 'string' ? relation.event_id : undefined;

  if (event.type === EventType.Reaction) {
    return relation?.rel_type === RelationType.Annotation && relation.key === LIKE_KEY && postId
      ? { ...base, kind: 'like', postId }
      : undefined;
  }
  if (event.type === COMMENT_EVENT_TYPE) {
    if (relation?.rel_type !== RelationType.Reference || !postId) return undefined;
    const replyTo = event.content['xyz.nekous.reply_to'] as { sender?: unknown } | undefined;
    return { ...base, kind: replyTo?.sender === myUserId ? 'reply' : 'comment', postId };
  }
  if (event.type === REPOST_RECEIPT_TYPE) {
    if (relation?.rel_type !== RelationType.Reference || !postId) return undefined;
    const target = event.content['xyz.nekous.repost_event'] as
      | { room_id?: unknown; event_id?: unknown; quote?: unknown }
      | undefined;
    if (target?.quote === true && typeof target.room_id === 'string' && typeof target.event_id === 'string') {
      return { ...base, kind: 'quote', postId, quote: { roomId: target.room_id, eventId: target.event_id } };
    }
    return { ...base, kind: 'repost', postId };
  }
  if (event.type === FOLLOWED_EVENT) return { ...base, kind: 'follow' };
  return undefined;
}

function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Raw events → activity rows, newest first. Likes and reposts group per post and follows per
 * day; everything else is a row of its own. Pure, so it's tested without a server.
 */
export function buildActivity(events: RawActivityEvent[], myUserId: string): ActivityItem[] {
  const seenEvents = new Set<string>();
  const rows = new Map<string, ActivityItem>();
  const sorted = [...events].sort((a, b) => b.origin_server_ts - a.origin_server_ts);

  for (const event of sorted) {
    if (seenEvents.has(event.event_id)) continue;
    seenEvents.add(event.event_id);
    const item = classify(event, myUserId);
    if (!item) continue;
    const { sender, ...rest } = item;
    const key = GROUPED.includes(item.kind)
      ? `${item.kind}|${item.kind === 'follow' ? dayOf(item.ts) : item.postId}`
      : event.event_id;
    const existing = rows.get(key);
    if (existing) {
      // Older than what's there (sorted newest first): it only adds a name.
      if (!existing.senders.includes(sender)) existing.senders.push(sender);
    } else {
      rows.set(key, { ...rest, key, senders: [sender] });
    }
  }
  return [...rows.values()].sort((a, b) => b.ts - a.ts);
}

/** How many of the newest events of the kinds above to read from each of your feed rooms. */
const PER_ROOM = 100;
const ACTIVITY_TYPES: string[] = [EventType.Reaction, COMMENT_EVENT_TYPE, REPOST_RECEIPT_TYPE, FOLLOWED_EVENT];

/** Your profile feed and your feed in each Space — where activity about you lands. */
export function ownFeedRoomIds(mx: MatrixClient): string[] {
  const profile = getOwnProfileRoomId(mx);
  return [...new Set([...(profile ? [profile] : []), ...listOwnFeedRoomIds(mx)])];
}

/** Whether an event is the kind Activity is made of — for noticing new activity as it arrives. */
export function isActivityEventType(type: string): boolean {
  return ACTIVITY_TYPES.includes(type);
}

async function recentEvents(mx: MatrixClient, roomId: string): Promise<RawActivityEvent[]> {
  const res = await mx.http.authedRequest<{ chunk?: Omit<RawActivityEvent, 'room_id'>[] }>(
    Method.Get,
    `/rooms/${encodeURIComponent(roomId)}/messages`,
    { dir: Direction.Backward, limit: String(PER_ROOM), filter: JSON.stringify({ types: ACTIVITY_TYPES }) }
  );
  return (res.chunk ?? []).map((event) => ({ ...event, room_id: roomId }));
}

type MentionEvent = { event: RawActivityEvent; postId: string };

/** Mentions and replies from other people's rooms, via the mention inbox: post and comment
 *  mentions only (a chat mention isn't activity). Each is read back to know who and what it is. */
async function mentionEvents(mx: MatrixClient): Promise<MentionEvent[]> {
  const refs = readMentionInbox(mx).filter((ref) => !!ref.postId);
  const read = await Promise.all(
    refs.map(async (ref): Promise<MentionEvent | undefined> => {
      try {
        const raw = (await mx.fetchRoomEvent(ref.roomId, ref.eventId)) as unknown as Omit<RawActivityEvent, 'room_id'>;
        return { event: { ...raw, room_id: ref.roomId }, postId: ref.postId as string };
      } catch {
        return undefined;
      }
    })
  );
  return read.filter((item): item is MentionEvent => !!item);
}

/** Everything above, read fresh. A room that can't be read right now is skipped, not fatal. */
export async function fetchActivity(mx: MatrixClient): Promise<ActivityItem[]> {
  const myUserId = mx.getUserId() ?? '';
  const [perRoom, mentions] = await Promise.all([
    Promise.all(ownFeedRoomIds(mx).map((roomId) => recentEvents(mx, roomId).catch(() => []))),
    mentionEvents(mx).catch(() => []),
  ]);
  const own = buildActivity(perRoom.flat(), myUserId);
  const known = new Set(own.map((item) => item.eventId));
  const elsewhere = mentions
    .filter(({ event }) => !known.has(event.event_id) && event.sender !== myUserId && !event.unsigned?.redacted_because)
    .map(({ event, postId }): ActivityItem => {
      const replyTo = event.content['xyz.nekous.reply_to'] as { sender?: unknown } | undefined;
      return {
        key: event.event_id,
        kind: event.type === COMMENT_EVENT_TYPE && replyTo?.sender === myUserId ? 'reply' : 'mention',
        senders: [event.sender],
        ts: event.origin_server_ts,
        roomId: event.room_id,
        eventId: event.event_id,
        postId,
      };
    });
  return [...own, ...elsewhere].sort((a, b) => b.ts - a.ts);
}

export const ACTIVITY_SEEN_ACCOUNT_DATA = 'xyz.nekous.activity_seen';

export function readActivitySeen(mx: MatrixClient): number {
  const ts = mx.getAccountData(ACTIVITY_SEEN_ACCOUNT_DATA as any)?.getContent<{ ts?: unknown }>()?.ts;
  return typeof ts === 'number' ? ts : 0;
}

/** Marks everything up to `ts` seen — never moving backwards, if another device got further. */
export async function markActivitySeen(mx: MatrixClient, ts: number): Promise<void> {
  const fresh = await readFreshAccountData<{ ts?: unknown }>(mx, ACTIVITY_SEEN_ACCOUNT_DATA);
  const current = typeof fresh?.ts === 'number' ? fresh.ts : 0;
  if (ts > current) await mx.setAccountData(ACTIVITY_SEEN_ACCOUNT_DATA as any, { ts } as any);
}

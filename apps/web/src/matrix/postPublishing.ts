import type { MatrixClient, Room } from 'matrix-js-sdk';
import { buildPostContent, deletePost, ensureFeedRoom, publishPost, type PostContent, type PostOrigin, type RepostOf } from './feed';
import type { FeedSource } from './globalFeed';
import { inviteMentioned } from './mentionInvites';
import { sendRepostReceipt, type MyRepost } from './postInteractions';
import { ensureProfileRoom } from './profileFeed';

/** Where a new post goes: your global profile feed, or your feed in one of your Spaces. */
export type PostTarget = { kind: 'global' } | { kind: 'space'; space: Room };

export function targetOrigin(target: PostTarget): PostOrigin {
  return target.kind === 'global' ? { kind: 'global' } : { kind: 'space', spaceId: target.space.roomId, spaceName: target.space.name };
}

/**
 * Publishes a post to its target, creating the feed room on first use, and hands back the source
 * it now lives in — so a timeline that didn't know about a brand-new feed can start reading it —
 * and the new post's event ID.
 */
export async function publishToTarget(
  mx: MatrixClient,
  target: PostTarget,
  content: PostContent,
  displayName: string,
  isPublic: boolean
): Promise<{ source: FeedSource; eventId: string }> {
  const roomId =
    target.kind === 'global'
      ? await ensureProfileRoom(mx, displayName)
      : await ensureFeedRoom(mx, target.space, displayName, isPublic);
  const eventId = await publishPost(mx, roomId, content);
  // A Global post's mentions only reach people in your profile room; everyone else is invited, so
  // the mention reaches them (mentionInvites.ts). A Space's members are already in its feeds.
  if (target.kind === 'global' && content.mentions?.length) {
    await inviteMentioned(mx, roomId, eventId, content.mentions);
  }
  const owner = mx.getUserId() ?? '';
  return {
    source: {
      roomId,
      owner,
      ownerName: displayName || owner,
      origin: targetOrigin(target),
      isPublic: target.kind === 'global' || isPublic,
    },
    eventId,
  };
}

/**
 * Reposts `repostOf` to `target` — a plain repost, or a quote when `comment` has text — and leaves
 * the marker on the original that counts it and tells its author (postInteractions.ts). The marker
 * is best-effort: the repost has already gone out, and a room you can't join isn't a reason to
 * call it failed.
 */
export async function repostToTarget(
  mx: MatrixClient,
  target: PostTarget,
  repostOf: RepostOf,
  displayName: string,
  isPublic: boolean,
  comment?: { body: string; formattedBody?: string }
): Promise<{ source: FeedSource; eventId: string }> {
  const body = comment?.body.trim() ?? '';
  const published = await publishToTarget(
    mx,
    target,
    buildPostContent(body, body ? comment?.formattedBody : undefined, { repostOf }),
    displayName,
    isPublic
  );
  await sendRepostReceipt(mx, repostOf.roomId, repostOf.eventId, repostOf.sender, {
    roomId: published.source.roomId,
    eventId: published.eventId,
    quote: !!body,
  }).catch(() => undefined);
  return published;
}

/** Undoes a repost: the marker on the original, then the repost itself. */
export async function undoRepost(mx: MatrixClient, originalRoomId: string, mine: MyRepost): Promise<void> {
  await mx.redactEvent(originalRoomId, mine.receiptId);
  await deletePost(mx, mine.roomId, mine.eventId);
}

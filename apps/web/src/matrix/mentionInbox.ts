import type { MatrixClient } from 'matrix-js-sdk';

/**
 * A private, per-user, cross-room log of messages that actually @-mentioned you (real
 * `m.mentions.user_ids` mentions — the same signal MessageTimeline.tsx uses for its own
 * highlight styling — not just any message in a room with notifications on), so you don't have
 * to scroll back through a busy channel to find one. Plain account data, same shape/precedent as
 * savedMessages.ts, but populated automatically (see MentionInboxCollector.tsx) rather than by a
 * manual per-message action.
 */
export const MENTION_INBOX_EVENT = 'xyz.nekous.mention_inbox';

/** Oldest entries drop off past this — an unbounded account-data event isn't a reasonable "log,"
 *  and nothing here needs to be a complete historical archive (same tradeoff as the audit log). */
const MAX_ITEMS = 50;

/**
 * `postId` is set for a mention in a post or a comment (in a feed room): the post to open, which for
 * a comment is the post it's under. A chat mention has none and opens in its channel.
 */
export type MentionRef = { roomId: string; eventId: string; mentionedAt: number; postId?: string };
type MentionInboxContent = { items?: MentionRef[] };

export function readMentionInbox(mx: MatrixClient): MentionRef[] {
  const content = mx.getAccountData(MENTION_INBOX_EVENT as any)?.getContent<MentionInboxContent>();
  return content?.items ?? [];
}

export async function addMentionToInbox(mx: MatrixClient, roomId: string, eventId: string, postId?: string): Promise<void> {
  const existing = readMentionInbox(mx);
  if (existing.some((item) => item.roomId === roomId && item.eventId === eventId)) return;
  const entry: MentionRef = { roomId, eventId, mentionedAt: Date.now(), ...(postId && { postId }) };
  const items = [...existing, entry].slice(-MAX_ITEMS);
  await mx.setAccountData(MENTION_INBOX_EVENT as any, { items } as any);
}

export async function removeMentionFromInbox(mx: MatrixClient, roomId: string, eventId: string): Promise<void> {
  const items = readMentionInbox(mx).filter((item) => !(item.roomId === roomId && item.eventId === eventId));
  await mx.setAccountData(MENTION_INBOX_EVENT as any, { items } as any);
}

export async function clearMentionInbox(mx: MatrixClient): Promise<void> {
  await mx.setAccountData(MENTION_INBOX_EVENT as any, { items: [] } as any);
}

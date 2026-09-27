import type { MatrixClient } from 'matrix-js-sdk';
import type { PostOrigin } from './feed';
import { readFreshAccountData } from './freshAccountData';

/**
 * The posts you've liked, for your profile's Likes tab. Nothing on the server can answer "what has
 * this person liked" — a like is a reaction sitting in the liked post's own room — so liking also
 * files the post here. It's your own account data: **only you see your likes**, the same choice
 * Twitter made, and consistent with nothing about a like being announced beyond the post itself.
 *
 * Only a reference is kept, not a copy: liking joined you to the post's room, so it can always be
 * read back fresh, edits and deletions included.
 */
export const LIKED_POSTS_ACCOUNT_DATA = 'xyz.nekous.liked_posts';

/** Oldest likes drop off past this; account data isn't a place for an unbounded log. */
const MAX_LIKED = 200;

export type LikedPost = {
  roomId: string;
  eventId: string;
  owner: string;
  ownerName: string;
  origin: PostOrigin;
  isPublic: boolean;
  likedAt: number;
};

function isLikedPost(raw: unknown): raw is LikedPost {
  const r = raw as Partial<LikedPost> | null;
  return !!r && typeof r.roomId === 'string' && typeof r.eventId === 'string' && typeof r.owner === 'string' && !!r.origin;
}

function listFrom(content: { items?: unknown } | undefined): LikedPost[] {
  return Array.isArray(content?.items) ? content.items.filter(isLikedPost) : [];
}

/** Newest like first. */
export function readLikedPosts(mx: MatrixClient): LikedPost[] {
  const content = mx.getAccountData(LIKED_POSTS_ACCOUNT_DATA as any)?.getContent<{ items?: unknown }>();
  return [...listFrom(content)].sort((a, b) => b.likedAt - a.likedAt);
}

async function update(mx: MatrixClient, change: (items: LikedPost[]) => LikedPost[]): Promise<void> {
  const fresh = await readFreshAccountData<{ items?: unknown }>(mx, LIKED_POSTS_ACCOUNT_DATA);
  await mx.setAccountData(LIKED_POSTS_ACCOUNT_DATA as any, { items: change(listFrom(fresh)) } as any);
}

export function recordLike(mx: MatrixClient, post: Omit<LikedPost, 'likedAt'>): Promise<void> {
  return update(mx, (items) =>
    [...items.filter((item) => item.eventId !== post.eventId), { ...post, likedAt: Date.now() }].slice(-MAX_LIKED)
  );
}

export function forgetLike(mx: MatrixClient, eventId: string): Promise<void> {
  return update(mx, (items) => items.filter((item) => item.eventId !== eventId));
}

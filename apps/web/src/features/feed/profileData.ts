import { useEffect, useState } from 'react';
import { ClientEvent, MatrixEvent } from 'matrix-js-sdk';
import type { OpenPost } from '../../app/state/selection';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { applyPostEdits, readPost } from '../../matrix/feed';
import { editsFromRaw, type FeedSource, type GlobalPost } from '../../matrix/globalFeed';
import type { PinnedPostRef } from '../../matrix/extendedProfile';
import { LIKED_POSTS_ACCOUNT_DATA, readLikedPosts, type LikedPost } from '../../matrix/likedPosts';

/** How many of your newest likes the Likes tab reads. */
const LIKES_SHOWN = 50;

/** One post read back by ID, as a timeline entry — with its latest edit when the server bundles it. */
async function fetchGlobalPost(mx: ReturnType<typeof useMatrixClient>, source: FeedSource, eventId: string): Promise<GlobalPost | undefined> {
  const raw = (await mx.fetchRoomEvent(source.roomId, eventId)) as Record<string, any>;
  const event = new MatrixEvent(raw);
  applyPostEdits([event], editsFromRaw([raw]));
  return readPost(event) ? { eventId, ts: event.getTs(), event, source } : undefined;
}

/**
 * Your Likes tab: the posts you've liked (likedPosts.ts), newest like first, read back fresh so an
 * edit or a deletion shows. Only ever your own — likes aren't public. A post that can't be read any
 * more (deleted, or a Space you've left) simply drops out.
 */
export function useLikedPosts(enabled: boolean): { posts: GlobalPost[]; loading: boolean } {
  const mx = useMatrixClient();
  const [liked, setLiked] = useState<LikedPost[]>(() => (enabled ? readLikedPosts(mx) : []));
  const [posts, setPosts] = useState<GlobalPost[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    setLiked(readLikedPosts(mx));
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === LIKED_POSTS_ACCOUNT_DATA) setLiked(readLikedPosts(mx));
    };
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx, enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setLoading(true);
    void Promise.all(
      liked.slice(0, LIKES_SHOWN).map((like) =>
        fetchGlobalPost(
          mx,
          { roomId: like.roomId, owner: like.owner, ownerName: like.ownerName, origin: like.origin, isPublic: like.isPublic },
          like.eventId
        ).catch(() => undefined)
      )
    ).then((read) => {
      if (cancelled) return;
      // Kept in the order you liked them, not the order they were posted.
      setPosts(read.filter((post): post is GlobalPost => !!post));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [mx, enabled, liked]);

  return { posts, loading };
}

/**
 * The post pinned to a profile, from the posts already loaded when it's among them, otherwise read
 * by ID — a pin can be older than anything the profile has paged back to.
 */
export function usePinnedGlobalPost(pinned: PinnedPostRef | undefined, loaded: GlobalPost[], sources: FeedSource[]): GlobalPost | undefined {
  const mx = useMatrixClient();
  const inLoaded = pinned ? loaded.find((post) => post.eventId === pinned.eventId) : undefined;
  const [fetched, setFetched] = useState<GlobalPost>();
  const source = pinned ? sources.find((s) => s.roomId === pinned.roomId) : undefined;

  useEffect(() => {
    setFetched(undefined);
    if (!pinned || inLoaded || !source) return undefined;
    let cancelled = false;
    void fetchGlobalPost(mx, source, pinned.eventId)
      .then((post) => {
        if (!cancelled) setFetched(post);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `inLoaded` only matters as present-or-not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, pinned?.roomId, pinned?.eventId, !!inLoaded, source]);

  return inLoaded ?? fetched;
}

/** A timeline entry as a post page to open — for a tile that shows a post without its card. */
export function openPostFrom(post: GlobalPost, canInteract: boolean, cannotInteractReason?: string): OpenPost | undefined {
  const content = readPost(post.event);
  if (!content) return undefined;
  const { source } = post;
  return {
    roomId: source.roomId,
    postId: post.eventId,
    isPublic: source.isPublic,
    canInteract,
    ...(cannotInteractReason && { cannotInteractReason }),
    content,
    edited: !!post.event.replacingEventId(),
    author: { userId: source.owner, name: source.ownerName, avatarUrl: source.ownerAvatarUrl },
    ts: post.ts,
    sourceOrigin: source.origin,
    showOrigin: true,
  };
}

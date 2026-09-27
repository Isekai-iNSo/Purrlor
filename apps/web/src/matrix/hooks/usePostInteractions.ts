import { useCallback, useEffect, useRef, useState } from 'react';
import { EventType, RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import {
  deleteComment,
  fetchComments,
  fetchLikes,
  fetchOlderComments,
  fetchReposts,
  likePost,
  mergeNewestPage,
  sendComment,
  unlikePost,
  type MyRepost,
  type OlderCursor,
  type PostComment,
  type ReplyTarget,
} from '../postInteractions';
import type { PostContent } from '../feed';

/** Every card on a page asks at once; this keeps it to a few requests in flight, the same budget
 *  the global feed uses for its own reads. */
const MAX_IN_FLIGHT = 6;
let inFlight = 0;
const queue: (() => void)[] = [];

function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      inFlight += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          inFlight -= 1;
          queue.shift()?.();
        });
    };
    if (inFlight < MAX_IN_FLIGHT) run();
    else queue.push(run);
  });
}

type State = {
  likeCount: number;
  likesTruncated: boolean;
  likers: string[];
  myLikeId?: string;
  repostCount: number;
  repostsTruncated: boolean;
  myRepost?: MyRepost;
  /** Loaded so far, oldest first — the newest page, plus any older pages asked for. */
  comments: PostComment[];
  /** Set while older comments exist on the server that haven't been loaded. */
  older?: OlderCursor;
};

const EMPTY: State = { likeCount: 0, likesTruncated: false, likers: [], repostCount: 0, repostsTruncated: false, comments: [] };

/**
 * A post's likes and comments, and the actions on them. A card reads its likes and the newest page
 * of comments; older comments load only when asked for (loadOlder), so a thread of any length
 * costs the same up front. In a feed room you've joined, a new like or comment re-reads the newest
 * page and merges it in, keeping anything older already loaded. A feed you haven't joined is a
 * snapshot, like its posts.
 */
export function usePostInteractions(roomId: string, postId: string, ownerId: string, postTs: number) {
  const mx = useMatrixClient();
  const [state, setState] = useState<State>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const alive = useRef(true);
  // Whether "load earlier" has ever run: until it has, the newest page's own cursor is the one to
  // keep; after, the one from the oldest page loaded is, and a refresh mustn't reset it.
  const pagedBack = useRef(false);

  const reload = useCallback(async () => {
    try {
      const [likes, newest, reposts] = await Promise.all([
        limited(() => fetchLikes(mx, roomId, postId, postTs)),
        limited(() => fetchComments(mx, roomId, postId)),
        // A server that can't answer this just shows no repost count.
        limited(() => fetchReposts(mx, roomId, postId)).catch(() => undefined),
      ]);
      if (!alive.current) return;
      setState((prev) => ({
        ...likes,
        repostCount: reposts?.repostCount ?? prev.repostCount,
        repostsTruncated: reposts?.repostsTruncated ?? prev.repostsTruncated,
        myRepost: reposts ? reposts.mine : prev.myRepost,
        comments: mergeNewestPage(prev.comments, newest.comments),
        older: pagedBack.current ? prev.older : newest.older,
      }));
    } catch {
      // A feed that can't be read right now just shows no likes/comments; the post still renders.
    } finally {
      if (alive.current) setLoaded(true);
    }
  }, [mx, roomId, postId, postTs]);

  useEffect(() => {
    alive.current = true;
    pagedBack.current = false;
    setState(EMPTY);
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onTimeline = (event: MatrixEvent, room: Room | undefined) => {
      if (room?.roomId !== roomId) return;
      if (event.getType() === EventType.RoomRedaction) {
        // A deleted comment older than the newest page wouldn't show up in a re-read of it.
        const redacted = event.event.redacts ?? (event.getContent() as { redacts?: string }).redacts;
        if (redacted) setState((s) => ({ ...s, comments: s.comments.filter((c) => c.eventId !== redacted) }));
      } else if (event.getRelation()?.event_id !== postId) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 400);
    };
    mx.on(RoomEvent.Timeline, onTimeline);
    return () => {
      clearTimeout(timer);
      mx.removeListener(RoomEvent.Timeline, onTimeline);
    };
  }, [mx, roomId, postId, reload]);

  const loadOlder = async () => {
    const from = state.older;
    if (!from || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await fetchOlderComments(mx, roomId, postId, from, postTs);
      if (!alive.current) return;
      pagedBack.current = true;
      setState((s) => {
        const known = new Set(s.comments.map((c) => c.eventId));
        return { ...s, comments: [...page.comments.filter((c) => !known.has(c.eventId)), ...s.comments], older: page.older };
      });
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  };

  /** Runs an action, then reloads whether it worked or not — so an optimistic like that failed is
   *  put back by the server's answer. The error still reaches the caller to show. */
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      await reload();
      if (alive.current) setBusy(false);
    }
  };

  const toggleLike = () =>
    act(async () => {
      // Shown right away; the reload that follows replaces it with the server's answer.
      if (state.myLikeId) {
        const likeId = state.myLikeId;
        setState((s) => ({ ...s, likeCount: Math.max(0, s.likeCount - 1), myLikeId: undefined }));
        await unlikePost(mx, roomId, likeId);
      } else {
        setState((s) => ({ ...s, likeCount: s.likeCount + 1, myLikeId: 'pending' }));
        await likePost(mx, roomId, postId, ownerId);
      }
    });

  return {
    ...state,
    loaded,
    busy,
    loadingOlder,
    loadOlder,
    toggleLike,
    addComment: (content: PostContent, replyTo?: ReplyTarget) =>
      act(() => sendComment(mx, roomId, postId, ownerId, content, replyTo)),
    removeComment: (commentId: string) =>
      act(async () => {
        await deleteComment(mx, roomId, commentId);
        setState((s) => ({ ...s, comments: s.comments.filter((c) => c.eventId !== commentId) }));
      }),
    reload,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { useMatrixClient } from '../MatrixClientContext';
import { applyPostEdits, editTargetOf, followSpaceFeeds } from '../feed';
import {
  dedupeSources,
  fetchFeedPage,
  fetchNewestPosts,
  GLOBAL_FEED_CONCURRENCY,
  listDirectory,
  loadProfileSource,
  loadListedSpaceSources,
  loadPublicSpaceSources,
  loadUserProfileSource,
  mapWithConcurrency,
  MAX_FEEDS,
  mergePosts,
  ownProfileSource,
  postsFromEvents,
  privateJoinedSpaces,
  privateJoinedSpaceSources,
  type FeedSource,
  type GlobalPost,
} from '../globalFeed';

export type GlobalFeed = {
  /** Every post from every readable source. Views narrow it with `filterPosts`. */
  posts: GlobalPost[];
  /** Posts that arrived after the timeline was shown, held back so nothing moves under the
   *  reader — the "N new posts" pill. `showNew` puts them in. Your own posts skip the wait. */
  pending: GlobalPost[];
  showNew: () => void;
  /** Every feed being read — profile sources carry who their owner follows (follower counts). */
  sources: FeedSource[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** Listed Spaces — the only Spaces a repost may come from or go to. */
  publicSpaceIds: Set<string>;
  /** Public Spaces from the directory, for "Spaces to follow". */
  publicSpaces: { roomId: string; name: string }[];
  /** Whether the directory has answered — until then, which Spaces are public is unknown. */
  directoryLoaded: boolean;
  unreadableSpaces: number;
  /** The directory had more public profiles/Spaces than are read, so Everyone is a sample. */
  directoryTruncated: boolean;
  error?: string;
  loadMore: () => void;
  refresh: () => void;
  /** After posting into a feed room this feed didn't know about yet (a first post creates it). */
  addSource: (source: FeedSource) => void;
};

/** People and Spaces to read whatever the directory caps say: follows, or the profile being viewed. */
export type Pinned = { users: string[]; spaces: string[] };
const NOTHING_PINNED: Pinned = { users: [], spaces: [] };

/** How often feeds this client isn't in are asked for new posts. */
const NEW_POSTS_CHECK_MS = 60_000;

/**
 * Everything the global feed, the Following timeline, and profiles read from — see
 * matrix/globalFeed.ts for what each source is and why Everyone is public-only.
 *
 * All sources are paged together (a timeline sorted across authors can't be paged one feed at
 * a time without misordering). Joined feed rooms update live; the rest are a snapshot, re-read
 * by `refresh`.
 */
export function useGlobalFeed(enabled: boolean, pinnedInput: Pinned = NOTHING_PINNED): GlobalFeed {
  const mx = useMatrixClient();
  // A string key, so a new-but-equal array from the caller doesn't reload everything.
  const pinnedKey = JSON.stringify([[...pinnedInput.users].sort(), [...pinnedInput.spaces].sort()]);
  const pinned = useMemo(() => {
    const [users, spaces] = JSON.parse(pinnedKey) as [string[], string[]];
    return { users, spaces };
  }, [pinnedKey]);
  const [directoryTruncated, setDirectoryTruncated] = useState(false);
  const [posts, setPosts] = useState<GlobalPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [publicSpaces, setPublicSpaces] = useState<{ roomId: string; name: string }[]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [unreadableSpaces, setUnreadableSpaces] = useState(0);
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<GlobalPost[]>([]);
  const [sources, setSources] = useState<FeedSource[]>([]);
  const tokensRef = useRef(new Map<string, string>());
  const sourcesRef = useRef(new Map<string, FeedSource>());
  // What's shown or waiting, for telling a new post from one already there.
  const knownIdsRef = useRef(new Set<string>());
  const busyRef = useRef(false);
  // Every post edit seen so far: an edit can arrive on a different page from its post.
  const editsRef = useRef<MatrixEvent[]>([]);
  const withEdits = useCallback((list: GlobalPost[]) => {
    applyPostEdits(
      list.map((post) => post.event),
      editsRef.current
    );
    return list;
  }, []);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const initialLoadRef = useRef(false);
  // Bumped when an initial load finishes, so pins added during it get picked up after.
  const [initialLoadDone, setInitialLoadDone] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    initialLoadRef.current = true;
    tokensRef.current = new Map();
    sourcesRef.current = new Map();
    knownIdsRef.current = new Set();
    editsRef.current = [];
    setPending([]);
    busyRef.current = true;
    setLoading(true);
    setError(undefined);

    void (async () => {
      try {
        const directory = await listDirectory(mx);
        if (cancelled) return;
        setPublicSpaces(directory.spaces.map(({ roomId, name }) => ({ roomId, name })));
        setDirectoryLoaded(true);
        const publicIds = new Set(directory.spaces.map((space) => space.roomId));

        // A private Space's feed rooms are members-only (feed.ts), so reading them means joining
        // them — which a member of the Space may do, and the Space's own Posts page does too.
        await mapWithConcurrency(privateJoinedSpaces(mx, publicIds), GLOBAL_FEED_CONCURRENCY, (space) =>
          followSpaceFeeds(mx, space)
        );
        if (cancelled) return;

        const [spaceResults, profileResults, own] = await Promise.all([
          mapWithConcurrency(directory.spaces, GLOBAL_FEED_CONCURRENCY, (space) => loadPublicSpaceSources(mx, space)),
          mapWithConcurrency(directory.profiles, GLOBAL_FEED_CONCURRENCY, (profile) => loadProfileSource(mx, profile.roomId)),
          ownProfileSource(mx),
        ]);
        if (cancelled) return;
        // `null` = won't show its state to non-members; `undefined` = the request failed.
        setUnreadableSpaces(spaceResults.filter((sources) => !sources).length);
        setDirectoryTruncated(directory.truncated);

        // People and Spaces asked for by name (followed, or the profile being viewed) that the
        // directory's capped pages didn't reach — read directly, so they're never missing.
        const profileOwners = new Set(profileResults.map((source) => source?.owner));
        const listedIds = new Set(directory.spaces.map((space) => space.roomId));
        const [pinnedProfiles, pinnedSpaces] = await Promise.all([
          mapWithConcurrency(
            pinnedRef.current.users.filter((userId) => !profileOwners.has(userId) && userId !== mx.getUserId()),
            GLOBAL_FEED_CONCURRENCY,
            (userId) => loadUserProfileSource(mx, userId)
          ),
          mapWithConcurrency(
            pinnedRef.current.spaces.filter((spaceId) => !listedIds.has(spaceId)),
            GLOBAL_FEED_CONCURRENCY,
            (spaceId) => loadListedSpaceSources(mx, spaceId)
          ),
        ]);
        if (cancelled) return;
        const pinnedSpaceSources = pinnedSpaces.flatMap((list) => list ?? []);
        const pinnedPublic = pinnedSpaceSources.flatMap((source) =>
          source.origin.kind === 'space' ? [{ roomId: source.origin.spaceId, name: source.origin.spaceName }] : []
        );
        if (pinnedPublic.length) {
          setPublicSpaces((prev) => [...prev, ...pinnedPublic.filter((space, i, all) => all.findIndex((s) => s.roomId === space.roomId) === i)]);
        }
        const allPublicIds = new Set([...publicIds, ...pinnedPublic.map((space) => space.roomId)]);

        // Asked-for sources go first, so the MAX_FEEDS cut never drops them.
        const sources = dedupeSources([
          ...(own ? [own] : []),
          ...pinnedProfiles.filter((source): source is FeedSource => !!source),
          ...pinnedSpaceSources,
          ...spaceResults.flatMap((list) => list ?? []),
          ...profileResults.filter((source): source is FeedSource => !!source),
          ...privateJoinedSpaceSources(mx, allPublicIds),
        ]).slice(0, MAX_FEEDS);
        sources.forEach((source) => sourcesRef.current.set(source.roomId, source));
        setSources([...sourcesRef.current.values()]);

        const pages = await mapWithConcurrency(sources, GLOBAL_FEED_CONCURRENCY, (source) => fetchFeedPage(mx, source));
        if (cancelled) return;
        let merged: GlobalPost[] = [];
        pages.forEach((page, index) => {
          if (!page) return;
          merged = mergePosts(merged, page.posts);
          editsRef.current.push(...page.edits);
          if (page.nextToken) tokensRef.current.set(sources[index].roomId, page.nextToken);
        });
        merged.forEach((post) => knownIdsRef.current.add(post.eventId));
        setPosts(withEdits(merged));
        setHasMore(tokensRef.current.size > 0);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Couldn’t load posts');
      } finally {
        busyRef.current = false;
        if (!cancelled) {
          setLoading(false);
          initialLoadRef.current = false;
          setInitialLoadDone((n) => n + 1);
        }
      }
    })();

    const onTimeline = (event: MatrixEvent, room: Room | undefined) => {
      const source = room && sourcesRef.current.get(room.roomId);
      if (!source) return;
      if (editTargetOf(event)) {
        editsRef.current.push(event);
        setPosts((prev) => (applyPostEdits(prev.map((post) => post.event), editsRef.current) ? [...prev] : prev));
        return;
      }
      const incoming = postsFromEvents(source, [event]).filter((post) => !knownIdsRef.current.has(post.eventId));
      if (!incoming.length) return;
      incoming.forEach((post) => knownIdsRef.current.add(post.eventId));
      // Your own post goes straight in — you just made it and expect to see it.
      if (event.getSender() === mx.getUserId()) setPosts((prev) => withEdits(mergePosts(prev, incoming)));
      else setPending((prev) => withEdits(mergePosts(prev, incoming)));
    };
    const onRedaction = (redaction: MatrixEvent) => {
      const redacted = redaction.event.redacts ?? redaction.getContent().redacts;
      if (!redacted) return;
      setPosts((prev) => prev.filter((post) => post.eventId !== redacted));
      setPending((prev) => prev.filter((post) => post.eventId !== redacted));
    };
    mx.on(RoomEvent.Timeline, onTimeline);
    mx.on(RoomEvent.Redaction, onRedaction);
    return () => {
      cancelled = true;
      mx.removeListener(RoomEvent.Timeline, onTimeline);
      mx.removeListener(RoomEvent.Redaction, onRedaction);
    };
  }, [mx, enabled, generation, withEdits]);

  const loadMore = useCallback(() => {
    if (busyRef.current || tokensRef.current.size === 0) return;
    busyRef.current = true;
    setLoadingMore(true);
    const pending = [...tokensRef.current.entries()];
    void mapWithConcurrency(pending, GLOBAL_FEED_CONCURRENCY, ([roomId, token]) => {
      const source = sourcesRef.current.get(roomId);
      return source ? fetchFeedPage(mx, source, token) : Promise.resolve(undefined);
    }).then((pages) => {
      let incoming: GlobalPost[] = [];
      pages.forEach((page, index) => {
        const [roomId] = pending[index];
        if (!page) return; // keeps its token, so the next "load older" retries it
        page.posts.forEach((post) => knownIdsRef.current.add(post.eventId));
        incoming = incoming.concat(page.posts);
        editsRef.current.push(...page.edits);
        if (page.nextToken) tokensRef.current.set(roomId, page.nextToken);
        else tokensRef.current.delete(roomId);
      });
      setPosts((prev) => withEdits(mergePosts(prev, incoming)));
      setHasMore(tokensRef.current.size > 0);
      setLoadingMore(false);
      busyRef.current = false;
    });
  }, [mx, withEdits]);

  const refresh = useCallback(() => setGeneration((n) => n + 1), []);

  const showNew = useCallback(() => {
    setPending((waiting) => {
      if (waiting.length) setPosts((prev) => withEdits(mergePosts(prev, waiting)));
      return [];
    });
  }, [withEdits]);

  const addSource = useCallback(
    (source: FeedSource) => {
      if (sourcesRef.current.has(source.roomId)) return;
      sourcesRef.current.set(source.roomId, source);
      setSources([...sourcesRef.current.values()]);
      void fetchFeedPage(mx, source)
        .then((page) => {
          editsRef.current.push(...page.edits);
          // Arriving from something you did (your first post there, or following someone): shown
          // at once rather than waiting behind the pill.
          page.posts.forEach((post) => knownIdsRef.current.add(post.eventId));
          setPosts((prev) => withEdits(mergePosts(prev, page.posts)));
        })
        .catch(() => undefined);
    },
    [mx, withEdits]
  );

  // Feeds this client is in update live (onTimeline, above). The rest are read over plain
  // /messages, so they're asked for their newest posts now and then — only while the window is
  // actually being looked at, and never over a load already in progress.
  useEffect(() => {
    if (!enabled) return undefined;
    let checking = false;
    const check = async () => {
      if (checking || busyRef.current || document.visibilityState !== 'visible') return;
      checking = true;
      try {
        const unjoined = [...sourcesRef.current.values()].filter(
          (source) => mx.getRoom(source.roomId)?.getMyMembership() !== 'join'
        );
        const pages = await mapWithConcurrency(unjoined, GLOBAL_FEED_CONCURRENCY, (source) => fetchNewestPosts(mx, source));
        const fresh: GlobalPost[] = [];
        let edited = false;
        pages.forEach((page) => {
          if (!page) return;
          if (page.edits.length) {
            editsRef.current.push(...page.edits);
            edited = true;
          }
          page.posts.forEach((post) => {
            if (knownIdsRef.current.has(post.eventId)) return;
            knownIdsRef.current.add(post.eventId);
            fresh.push(post);
          });
        });
        if (fresh.length) setPending((prev) => withEdits(mergePosts(prev, fresh)));
        if (edited) setPosts((prev) => (applyPostEdits(prev.map((post) => post.event), editsRef.current) ? [...prev] : prev));
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), NEW_POSTS_CHECK_MS);
    return () => clearInterval(timer);
  }, [mx, enabled, generation, withEdits]);

  // Following someone new mid-session adds just their feeds, rather than reloading the timeline.
  // During the initial load there's nothing to add to yet: that load reads pinnedRef itself, and
  // re-runs this when it's done in case the pins changed meanwhile.
  useEffect(() => {
    if (!enabled || initialLoadRef.current) return;
    const owners = new Set([...sourcesRef.current.values()].map((source) => source.owner));
    const spaces = new Set(
      [...sourcesRef.current.values()].flatMap((source) => (source.origin.kind === 'space' ? [source.origin.spaceId] : []))
    );
    pinned.users
      .filter((userId) => !owners.has(userId) && userId !== mx.getUserId())
      .forEach((userId) => {
        void loadUserProfileSource(mx, userId)
          .then((source) => source && addSource(source))
          .catch(() => undefined);
      });
    pinned.spaces
      .filter((spaceId) => !spaces.has(spaceId))
      .forEach((spaceId) => {
        void loadListedSpaceSources(mx, spaceId)
          .then((list) => list?.forEach(addSource))
          .catch(() => undefined);
      });
  }, [mx, enabled, pinned, addSource, initialLoadDone]);

  const publicSpaceIds = new Set(publicSpaces.map((space) => space.roomId));

  return {
    posts,
    pending,
    showNew,
    sources,
    loading,
    loadingMore,
    hasMore,
    publicSpaceIds,
    publicSpaces,
    directoryLoaded,
    directoryTruncated,
    unreadableSpaces,
    error,
    loadMore,
    refresh,
    addSource,
  };
}

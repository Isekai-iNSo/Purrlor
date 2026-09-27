import { useEffect, useMemo, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { Room } from 'matrix-js-sdk';
import { profileUserIdAtom, selectedSpaceViewAtom } from '../../app/state/selection';
import { useConfirm } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { MenuItem } from '../../components/Menu';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  buildPostContent,
  deletePost,
  deletePrivatePost,
  ensureFeedRoom,
  makePostPrivate,
  publishPrivatePost,
  readPost,
  readPrivatePosts,
  repostOfPost,
  type PostOrigin,
  type PrivatePost,
} from '../../matrix/feed';
import { useOwnProfile } from '../../matrix/hooks/useOwnProfile';
import { usePublicSpaceIds } from '../../matrix/hooks/usePublicSpaceIds';
import { useRoomEmotes } from '../../matrix/hooks/useRoomEmotes';
import { useRoomMembers } from '../../matrix/hooks/useRoomMembers';
import { useSpaceFeed, type FeedPost } from '../../matrix/hooks/useSpaceFeed';
import { buildMessageFormatting } from '../../matrix/messageFormatting';
import { markPostsSeen } from '../../matrix/postsSeen';
import { InteractivePost } from './InteractivePost';
import { PostCard } from './PostCard';
import { PostComposer, type ComposerTarget } from './PostComposer';
import { repostTargetsFor, useComposerTargets } from './useComposerTargets';
import { useInfiniteScroll } from './useInfiniteScroll';
import { useKeptScroll } from './useKeptScroll';
import './FeedView.css';

type Tab = 'hub' | 'mine';

/** A Space's own Posts page: its members' posts, and the place to post into this Space. */
export function FeedView({ space, hidden = false }: { space: Room; hidden?: boolean }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const setSpaceView = useSetAtom(selectedSpaceViewAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const { posts, loading, loadingMore, hasMore, loadMore } = useSpaceFeed(space);
  const members = useRoomMembers(space.roomId);
  const emotes = useRoomEmotes(space);
  const { displayName: myDisplayName } = useOwnProfile();
  const { ids: publicSpaceIds, loaded: publicnessKnown } = usePublicSpaceIds();
  const allTargets = useComposerTargets(publicSpaceIds);
  const spaceIsPublic = publicSpaceIds.has(space.roomId);
  const spaceOrigin: PostOrigin = useMemo(
    () => ({ kind: 'space', spaceId: space.roomId, spaceName: space.name }),
    [space.roomId, space.name]
  );
  // A public Space's posts can go anywhere public; a private one's stay inside this Space.
  const repostTargets = useMemo(
    () => repostTargetsFor(allTargets, spaceOrigin, spaceIsPublic),
    [allTargets, spaceOrigin, spaceIsPublic]
  );

  const [tab, setTab] = useState<Tab>('hub');
  const [error, setError] = useState<string>();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const scroll = useKeptScroll<HTMLDivElement>(hidden);
  const sentinelRef = useInfiniteScroll({ hasMore, loading: loading || loadingMore, onLoadMore: loadMore });
  // Account data has no live-update hook in this codebase, and a private post only ever changes
  // in response to something done right here — so this view re-reads on its own actions.
  const [privateRevision, setPrivateRevision] = useState(0);

  const privatePosts = useMemo(
    () => readPrivatePosts(mx, space.roomId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mx, space.roomId, privateRevision]
  );
  const myPosts = useMemo(() => posts.filter((post) => post.sender === myUserId), [posts, myUserId]);

  // Open means seen: clears the Posts row's "new" dot, here and on your other devices.
  useEffect(() => {
    void markPostsSeen(mx, space).catch(() => undefined);
  }, [mx, space, posts]);

  // This page posts into this Space only; Global and other Spaces are the global feed's picker.
  const composerTargets: ComposerTarget[] = useMemo(
    () => [{ id: space.roomId, label: space.name, isPublic: spaceIsPublic, target: { kind: 'space', space } }],
    [space, spaceIsPublic]
  );

  const nameOf = (userId: string) => members.find((member) => member.userId === userId)?.name ?? userId;
  const avatarOf = (userId: string) => members.find((member) => member.userId === userId)?.getMxcAvatarUrl() ?? null;

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    }
  };

  const handlePublishPrivate = (post: PrivatePost) =>
    run(async () => {
      const feedRoomId = await ensureFeedRoom(mx, space, myDisplayName || myUserId, spaceIsPublic);
      const { formattedBody } = buildMessageFormatting(post.body, emotes, []);
      await publishPrivatePost(
        mx,
        feedRoomId,
        post,
        buildPostContent(post.body, formattedBody, { attachments: post.attachments })
      );
      setPrivateRevision((n) => n + 1);
    }, 'Failed to publish that post');

  const renderPost = (post: FeedPost) => {
    const content = readPost(post.event);
    if (!content) return null;
    const mine = post.sender === myUserId;
    return (
      <InteractivePost
        key={post.eventId}
        roomId={post.roomId}
        postId={post.eventId}
        sourceOrigin={spaceOrigin}
        isPublic={spaceIsPublic}
        canInteract
        content={content}
        edited={!!post.event.replacingEventId()}
        author={{ userId: post.sender, name: nameOf(post.sender), avatarUrl: avatarOf(post.sender) }}
        ts={post.ts}
        myUserId={myUserId}
        emotes={emotes}
        members={members}
        onOpenProfile={setProfileUserId}
        {...(repostTargets.length > 0 && {
          repost: {
            repostOf: repostOfPost(
              {
                roomId: post.roomId,
                eventId: post.eventId,
                sender: post.sender,
                senderName: nameOf(post.sender),
                origin: spaceOrigin,
                ts: post.ts,
              },
              content
            ),
            targets: repostTargets,
          },
        })}
        {...(mine && { onDelete: () => deletePost(mx, post.roomId, post.eventId) })}
        extraMenuItems={
          mine && (
            <MenuItem
              icon="eyeOff"
              role="feed-post-make-private"
              onSelect={async () => {
                const ok = await confirm({
                  title: 'Make post private',
                  message:
                    'Take this post down so only you can see it? You can publish it again later from Yours, but its likes and comments won’t come back.',
                  confirmLabel: 'Make private',
                });
                if (!ok) return;
                await run(async () => {
                  await makePostPrivate(mx, space.roomId, post.roomId, post.event);
                  setPrivateRevision((n) => n + 1);
                }, 'Failed to make that post private');
              }}
            >
              Make private
            </MenuItem>
          )
        }
      />
    );
  };

  const renderPrivatePost = (post: PrivatePost) => (
    <PostCard
      key={post.id}
      role="feed-private-post"
      privateBadge
      content={{ body: post.body, ...(post.attachments && { attachments: post.attachments }) }}
      author={{ userId: myUserId, name: myDisplayName || myUserId }}
      ts={post.createdAt}
      myUserId={myUserId}
      emotes={emotes}
      members={members}
      actions={
        <>
          <button type="button" className="nu-post__action" data-nu-role="feed-private-publish" onClick={() => handlePublishPrivate(post)}>
            Publish
          </button>
          <button
            type="button"
            className="nu-post__action nu-post__action--danger"
            data-nu-role="feed-private-delete"
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete private post',
                message: 'Delete this post? Nobody else has seen it, and it can’t be recovered.',
                confirmLabel: 'Delete',
              });
              if (!ok) return;
              await run(async () => {
                await deletePrivatePost(mx, post.id);
                setPrivateRevision((n) => n + 1);
              }, 'Failed to delete that post');
            }}
          >
            Delete
          </button>
        </>
      }
    />
  );

  const shown = tab === 'hub' ? posts : myPosts;
  const empty = shown.length === 0 && (tab === 'hub' || privatePosts.length === 0);

  return (
    <main className="nu-main-pane" data-nu-role="main-pane" style={hidden ? { display: 'none' } : undefined}>
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <button
          type="button"
          className="nu-main-pane__header-back"
          data-nu-role="main-pane-back"
          title="Back to channels"
          aria-label="Back to channels"
          onClick={() => setSpaceView(null)}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <Icon name="posts" size={20} className="nu-main-pane__header-icon" />
        <h1 className="nu-main-pane__header-name">Posts</h1>
        <div className="nu-main-pane__header-actions">
          <div className="nu-feed__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'hub'}
              className={tab === 'hub' ? 'nu-feed__tab nu-feed__tab--active' : 'nu-feed__tab'}
              data-nu-role="feed-tab-hub"
              onClick={() => setTab('hub')}
            >
              Everyone
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mine'}
              className={tab === 'mine' ? 'nu-feed__tab nu-feed__tab--active' : 'nu-feed__tab'}
              data-nu-role="feed-tab-mine"
              onClick={() => setTab('mine')}
            >
              Yours
            </button>
          </div>
        </div>
      </div>

      <div className="nu-feed" data-nu-role="feed" ref={scroll.ref} onScroll={scroll.onScroll}>
        <PostComposer
          targets={composerTargets}
          ready={publicnessKnown}
          emotes={emotes}
          allowPrivate
          placeholder={`Post something to ${space.name}…`}
          onPrivateSaved={() => {
            setPrivateRevision((n) => n + 1);
            setTab('mine');
          }}
        />

        {error && (
          <p className="nu-field__error" data-nu-role="feed-error">
            {error}
          </p>
        )}

        {tab === 'mine' && privatePosts.map(renderPrivatePost)}
        {shown.map(renderPost)}

        {loading && (
          <p className="nu-feed__status" data-nu-role="feed-loading">
            Catching up on everyone's posts…
          </p>
        )}
        {!loading && empty && (
          <p className="nu-feed__status" data-nu-role="feed-empty">
            {tab === 'hub' ? 'Nothing posted here yet. Be the first.' : "You haven't posted here yet."}
          </p>
        )}
        {loadingMore && <p className="nu-feed__status">Loading older posts…</p>}
        <div ref={sentinelRef} className="nu-feed__sentinel" aria-hidden="true" />
      </div>
      {confirmDialog}
    </main>
  );
}

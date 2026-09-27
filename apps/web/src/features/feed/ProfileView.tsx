import { useEffect, useState } from 'react';
import { useSetAtom } from 'jotai';
import { profileUserIdAtom, selectedRoomIdAtom, selectedSpaceIdAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { createDirectMessage, findExistingDirectMessageRoomId } from '../../matrix/directMessages';
import { setFollowing } from '../../matrix/follows';
import { readPost } from '../../matrix/feed';
import { filterPosts } from '../../matrix/globalFeed';
import { useExtendedProfile } from '../../matrix/hooks/useExtendedProfile';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useGlobalFeed } from '../../matrix/hooks/useGlobalFeed';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { handleFor } from '../../matrix/roles';
import { GlobalPostList } from './GlobalPostList';
import { MediaGrid } from './MediaGrid';
import { PeopleListModal } from './PeopleListModal';
import { PostComposer } from './PostComposer';
import { useComposerTargets } from './useComposerTargets';
import { useInfiniteScroll } from './useInfiniteScroll';
import { useKeptScroll } from './useKeptScroll';
import { useLikedPosts, usePinnedGlobalPost } from './profileData';
import './FeedView.css';
import './ProfileView.css';

type ProfileTab = 'posts' | 'media' | 'likes';

/**
 * A person's page: banner, bio, Message and Follow, who they follow and who follows them, and
 * their posts — their Global posts, posts in public Spaces, and posts in Spaces you share with
 * them (you're a member of those; nobody else sees them here) — with the one they pinned first.
 * Media is the same posts as a grid of their photos and videos. Your own profile gets a composer
 * and a Likes tab, which only you can see.
 */
export function ProfileView({ userId, hidden = false }: { userId: string; hidden?: boolean }) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const isMe = userId === myUserId;
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  // This person's profile feed is read directly, even past the directory caps.
  const feed = useGlobalFeed(true, { users: [userId], spaces: [] });
  const follows = useFollows();
  const targets = useComposerTargets(feed.publicSpaceIds);
  const { profile: extended } = useExtendedProfile(userId);
  const bannerSrc = useMediaUrl(extended.bannerUrl, { width: 1200, height: 360, method: 'crop' });
  const [basic, setBasic] = useState<{ name: string; avatarUrl?: string }>(() => {
    const user = mx.getUser(userId);
    return { name: user?.displayName || userId, avatarUrl: user?.avatarUrl };
  });
  const [followError, setFollowError] = useState<string>();
  const setSelectedSpaceId = useSetAtom(selectedSpaceIdAtom);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);
  const [startingDm, setStartingDm] = useState(false);
  const scroll = useKeptScroll<HTMLDivElement>(hidden);
  const [tab, setTab] = useState<ProfileTab>('posts');

  // Same as the profile card's Message: reuse an existing DM or start one. Selecting the room
  // closes this page (MainPane does that for any route to a room).
  const handleMessage = async () => {
    if (startingDm) return;
    setStartingDm(true);
    setFollowError(undefined);
    try {
      const roomId = findExistingDirectMessageRoomId(mx, userId) ?? (await createDirectMessage(mx, userId));
      setSelectedSpaceId(null);
      setSelectedRoomId(roomId);
    } catch (err) {
      setFollowError(err instanceof Error ? err.message : 'Couldn’t start that conversation');
      setStartingDm(false);
    }
  };

  // The global profile, for someone you may share no rooms with (so no cached User).
  useEffect(() => {
    let cancelled = false;
    mx.getProfileInfo(userId)
      .then((info) => {
        if (!cancelled) setBasic({ name: info.displayname || userId, avatarUrl: info.avatar_url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mx, userId]);

  const posts = filterPosts(feed.posts, { kind: 'profile', userId });
  const newCount = filterPosts(feed.pending, { kind: 'profile', userId }).length;
  const following = follows.users.includes(userId);

  // Follows are published on profiles (profileFeed.ts), and the global feed reads every listed
  // profile's state already — so who follows whom comes from the sources it loaded. Your own
  // follows are also your account data, which is current the instant you tap Follow.
  const followingList = isMe
    ? follows.users
    : (feed.sources.find((source) => source.origin.kind === 'global' && source.owner === userId)?.follows ?? []);
  const followerList = [
    ...new Set(
      feed.sources
        .filter((source) => source.origin.kind === 'global' && source.owner !== myUserId && source.follows?.includes(userId))
        .map((source) => source.owner)
    ),
    ...(following ? [myUserId] : []),
  ];
  const [peopleList, setPeopleList] = useState<'followers' | 'following'>();

  const pinnedPost = usePinnedGlobalPost(extended.pinnedPost, feed.posts, feed.sources);
  const liked = useLikedPosts(isMe && tab === 'likes');
  const listed = pinnedPost ? posts.filter((post) => post.eventId !== pinnedPost.eventId) : posts;

  const sentinelRef = useInfiniteScroll({
    hasMore: feed.hasMore && tab !== 'likes',
    loading: feed.loading || feed.loadingMore,
    onLoadMore: feed.loadMore,
  });

  const tabButton = (value: ProfileTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      className={tab === value ? 'nu-profile-view__tab nu-profile-view__tab--active' : 'nu-profile-view__tab'}
      data-nu-role={`profile-tab-${value}`}
      onClick={() => setTab(value)}
    >
      {label}
    </button>
  );

  return (
    <main className="nu-main-pane" data-nu-role="main-pane" style={hidden ? { display: 'none' } : undefined}>
      <div className="nu-main-pane__header" data-nu-role="main-pane-header">
        <button
          type="button"
          className="nu-main-pane__header-back nu-profile-view__back"
          data-nu-role="profile-view-back"
          title="Back"
          aria-label="Back"
          onClick={() => setProfileUserId(null)}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <h1 className="nu-main-pane__header-name">{basic.name}</h1>
      </div>

      <div className="nu-feed" data-nu-role="profile-view" ref={scroll.ref} onScroll={scroll.onScroll}>
        <section className="nu-profile-view__card">
          <div
            className="nu-profile-view__banner"
            style={bannerSrc ? { backgroundImage: `url(${bannerSrc})` } : undefined}
            data-nu-role="profile-view-banner"
          />
          <div className="nu-profile-view__identity">
            <div className="nu-profile-view__avatar">
              <Avatar name={basic.name} mxcUrl={basic.avatarUrl ?? null} size={88} animated={extended.avatarAnimated} />
            </div>
            {!isMe && (
              <div className="nu-profile-view__actions">
                <button
                  type="button"
                  className="nu-follow-button nu-follow-button--on"
                  data-nu-role="profile-message"
                  disabled={startingDm}
                  onClick={() => void handleMessage()}
                >
                  {startingDm ? 'Opening…' : 'Message'}
                </button>
                <button
                  type="button"
                  className={following ? 'nu-follow-button nu-follow-button--on' : 'nu-follow-button'}
                  data-nu-role="profile-follow"
                  aria-pressed={following}
                  onClick={() => {
                    setFollowError(undefined);
                    setFollowing(mx, 'user', userId).catch((err) =>
                      setFollowError(err instanceof Error ? err.message : 'Couldn’t update follows')
                    );
                  }}
                >
                  {following ? 'Following' : 'Follow'}
                </button>
              </div>
            )}
          </div>
          <h2 className="nu-profile-view__name">{basic.name}</h2>
          <p className="nu-profile-view__handle">{handleFor(userId)}</p>
          {extended.bio && <p className="nu-profile-view__bio">{extended.bio}</p>}
          <p className="nu-profile-view__counts">
            <button type="button" className="nu-profile-view__count-link" data-nu-role="profile-following" onClick={() => setPeopleList('following')}>
              <strong>{followingList.length}</strong> Following
            </button>
            <button type="button" className="nu-profile-view__count-link" data-nu-role="profile-followers" onClick={() => setPeopleList('followers')}>
              <strong>{feed.loading && !isMe ? '…' : followerList.length}</strong> {followerList.length === 1 ? 'Follower' : 'Followers'}
            </button>
          </p>
          {followError && <p className="nu-field__error">{followError}</p>}
        </section>

        <div className="nu-profile-view__tabs" role="tablist">
          {tabButton('posts', 'Posts')}
          {tabButton('media', 'Media')}
          {isMe && tabButton('likes', 'Likes')}
        </div>

        {tab === 'posts' && (
          <>
            {isMe && <PostComposer targets={targets} ready={feed.directoryLoaded} placeholder="Post something…" onPublished={feed.addSource} />}
            {newCount > 0 && (
              <button
                type="button"
                className="nu-feed__new-posts"
                data-nu-role="profile-new-posts"
                onClick={() => {
                  feed.showNew();
                  scroll.ref.current?.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                <Icon name="arrowUp" size={14} />
                {newCount === 1 ? '1 new post' : `${newCount} new posts`}
              </button>
            )}
            {pinnedPost && (
              <div className="nu-profile-view__pinned" data-nu-role="profile-pinned">
                <span className="nu-profile-view__pinned-label">
                  <Icon name="pin" size={13} />
                  Pinned
                </span>
                <GlobalPostList posts={[pinnedPost]} targets={targets} onReposted={feed.addSource} />
              </div>
            )}
            <GlobalPostList posts={listed} targets={targets} onReposted={feed.addSource} />
            {!feed.loading && posts.length === 0 && !pinnedPost && (
              <p className="nu-feed__status" data-nu-role="profile-view-empty">
                {isMe ? 'You haven’t posted anywhere yet.' : `${basic.name} hasn’t posted anywhere you can see.`}
              </p>
            )}
          </>
        )}

        {tab === 'media' && (
          <>
            <MediaGrid posts={posts} />
            {!feed.loading && !feed.hasMore && !posts.some((post) => readPost(post.event)?.attachments?.length) && (
              <p className="nu-feed__status" data-nu-role="profile-media-empty">
                {isMe ? 'Photos and videos you post show up here.' : `${basic.name} hasn’t posted any photos or videos you can see.`}
              </p>
            )}
          </>
        )}

        {tab === 'likes' && isMe && (
          <>
            <p className="nu-profile-view__private-note">
              <Icon name="eyeOff" size={13} />
              Only you can see your likes.
            </p>
            <GlobalPostList posts={liked.posts} targets={targets} onReposted={feed.addSource} />
            {liked.loading && <p className="nu-feed__status">Loading your likes…</p>}
            {!liked.loading && liked.posts.length === 0 && (
              <p className="nu-feed__status" data-nu-role="profile-likes-empty">
                Posts you like show up here.
              </p>
            )}
          </>
        )}

        {tab !== 'likes' && (feed.loading || feed.loadingMore) && (
          <p className="nu-feed__status">{feed.loading ? 'Loading posts…' : 'Loading older posts…'}</p>
        )}
        <div ref={sentinelRef} className="nu-feed__sentinel" aria-hidden="true" />
      </div>

      {peopleList && (
        <PeopleListModal
          title={peopleList === 'followers' ? `Followers of ${basic.name}` : `${basic.name} follows`}
          userIds={peopleList === 'followers' ? followerList : followingList}
          emptyText={
            peopleList === 'followers'
              ? 'No followers yet.'
              : isMe
                ? 'You aren’t following anyone yet.'
                : `${basic.name} isn’t following anyone yet.`
          }
          {...(peopleList === 'followers' &&
            feed.directoryTruncated && {
              note: 'Counted from the profiles this server lists, so a few may be missing on a very big server.',
            })}
          onClose={() => setPeopleList(undefined)}
        />
      )}
    </main>
  );
}

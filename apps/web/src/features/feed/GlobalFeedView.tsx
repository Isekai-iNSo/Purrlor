import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { activityAtom, composerFocusAtom, feedSearchAtom } from '../../app/state/feed';
import { globalFeedOpenAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { setFollowing } from '../../matrix/follows';
import { filterPosts, type GlobalPost } from '../../matrix/globalFeed';
import { parsePostQuery, postMatchesQuery } from '../../matrix/hashtags';
import { readPost } from '../../matrix/feed';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useGlobalFeed } from '../../matrix/hooks/useGlobalFeed';
import { useSpaces } from '../../matrix/hooks/useSpaces';
import { ActivityView } from './ActivityView';
import { GlobalPostList } from './GlobalPostList';
import { PostComposer } from './PostComposer';
import { useComposerTargets } from './useComposerTargets';
import { useInfiniteScroll } from './useInfiniteScroll';
import { useKeptScroll } from './useKeptScroll';
import './FeedView.css';
import './GlobalFeedView.css';

type Tab = 'everyone' | 'following' | 'activity';

/** A search reads further back on its own this many times; past that, the reader asks for more.
 *  Without a cap, a search for something that isn't there would read every feed to its start. */
const SEARCH_AUTO_PAGES = 4;

/**
 * The global feed. **Everyone** is posts from public places only — people's Global posts and
 * public Spaces, including ones you haven't joined. **Following** is the people and whole Spaces
 * you follow, which may include Spaces you're a member of that aren't public (you can already
 * read those; nobody else sees them here). **Activity** is what people did with your posts.
 *
 * Search (words, or a `#tag`) runs over the posts the current tab has loaded, reading further
 * back a few pages at a time — there's no server-side index to ask (matrix/hashtags.ts).
 */
export function GlobalFeedView({ hidden = false }: { hidden?: boolean }) {
  const mx = useMatrixClient();
  const open = useAtomValue(globalFeedOpenAtom);
  const setGlobalFeedOpen = useSetAtom(globalFeedOpenAtom);
  const follows = useFollows();
  // Whoever you follow is read directly, even past the directory caps.
  const feed = useGlobalFeed(open, follows);
  const joinedSpaces = useSpaces();
  const targets = useComposerTargets(feed.publicSpaceIds);
  const [tab, setTab] = useState<Tab>('everyone');
  const [managing, setManaging] = useState(false);
  const [followError, setFollowError] = useState<string>();
  const [search, setSearch] = useAtom(feedSearchAtom);
  const { items: activity, seenTs } = useAtomValue(activityAtom);
  const scroll = useKeptScroll<HTMLDivElement>(hidden);
  const query = parsePostQuery(search);
  const searching = query.kind !== 'none';
  const activityUnread = activity.some((item) => item.ts > seenTs);

  // A tag tapped anywhere lands here with the search already set; Activity has no posts to search.
  useEffect(() => {
    if (searching && tab === 'activity') setTab('everyone');
  }, [searching, tab]);

  // The N shortcut wants the composer, which Activity doesn't have.
  const focusRequest = useAtomValue(composerFocusAtom);
  useEffect(() => {
    if (focusRequest) setTab((current) => (current === 'activity' ? 'everyone' : current));
  }, [focusRequest]);

  const timeline = (posts: GlobalPost[]) =>
    tab === 'following'
      ? filterPosts(posts, { kind: 'following', users: follows.users, spaces: follows.spaces })
      : filterPosts(posts, { kind: 'everyone' });
  const inTab = timeline(feed.posts);
  const shown = searching
    ? inTab.filter((post) => {
        const content = readPost(post.event);
        return !!content && postMatchesQuery(content, query, post.source.ownerName);
      })
    : inTab;
  const newCount = searching || tab === 'activity' ? 0 : timeline(feed.pending).length;
  const followsNothing = follows.users.length === 0 && follows.spaces.length === 0;

  // How many pages this search has read on its own; reset whenever the search changes.
  const searchPagesRef = useRef(0);
  const [searchPaused, setSearchPaused] = useState(false);
  useEffect(() => {
    searchPagesRef.current = 0;
    setSearchPaused(false);
  }, [search]);
  const loadMore = () => {
    if (searching) {
      if (searchPagesRef.current >= SEARCH_AUTO_PAGES) {
        setSearchPaused(true);
        return;
      }
      searchPagesRef.current += 1;
    }
    feed.loadMore();
  };
  const sentinelRef = useInfiniteScroll({
    hasMore: feed.hasMore && tab !== 'activity' && !searchPaused,
    loading: feed.loading || feed.loadingMore,
    onLoadMore: loadMore,
  });

  // Spaces worth offering to follow: every public one, plus your own — de-duplicated, by name.
  const followableSpaces = [
    ...feed.publicSpaces,
    ...joinedSpaces
      .filter((space) => !feed.publicSpaceIds.has(space.roomId))
      .map((space) => ({ roomId: space.roomId, name: space.name })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const toggle = (kind: 'user' | 'space', id: string) => {
    setFollowError(undefined);
    setFollowing(mx, kind, id).catch((err) => setFollowError(err instanceof Error ? err.message : 'Couldn’t update follows'));
  };

  const nameOfUser = (userId: string) =>
    feed.posts.find((post) => post.source.owner === userId)?.source.ownerName ?? mx.getUser(userId)?.displayName ?? userId;

  const showManager = tab === 'following' && !searching && (managing || followsNothing);

  const showNewPosts = () => {
    feed.showNew();
    scroll.ref.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const tabButton = (value: Tab, label: string, extra?: ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      className={tab === value ? 'nu-feed__tab nu-feed__tab--active' : 'nu-feed__tab'}
      data-nu-role={`global-feed-tab-${value}`}
      onClick={() => {
        setTab(value);
        if (value === 'activity') setSearch('');
      }}
    >
      {label}
      {extra}
    </button>
  );

  return (
    <main className="nu-main-pane" data-nu-role="main-pane" style={hidden ? { display: 'none' } : undefined}>
      <div className="nu-main-pane__header nu-global-feed__header" data-nu-role="main-pane-header">
        <button
          type="button"
          className="nu-main-pane__header-back"
          data-nu-role="main-pane-back"
          title="Close the global feed"
          aria-label="Close the global feed"
          onClick={() => setGlobalFeedOpen(false)}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <Icon name="globe" size={20} className="nu-main-pane__header-icon" />
        <h1 className="nu-main-pane__header-name">Global feed</h1>
        <div className="nu-main-pane__header-actions">
          <div className="nu-feed__tabs" role="tablist">
            {tabButton('everyone', 'Everyone')}
            {tabButton('following', 'Following')}
            {tabButton(
              'activity',
              'Activity',
              activityUnread && tab !== 'activity' && (
                <span className="nu-feed__tab-dot" data-nu-role="global-feed-activity-dot" aria-label="New activity" />
              )
            )}
          </div>
          <button
            type="button"
            className="nu-main-pane__header-action"
            data-nu-role="global-feed-refresh"
            title="Refresh"
            aria-label="Refresh"
            disabled={feed.loading}
            onClick={feed.refresh}
          >
            <Icon name="refresh" size={17} />
          </button>
        </div>
      </div>

      <div className="nu-feed" data-nu-role="global-feed" ref={scroll.ref} onScroll={scroll.onScroll}>
        {tab === 'activity' ? (
          <ActivityView />
        ) : (
          <>
            <div className="nu-feed-search" data-nu-role="global-feed-search">
              <Icon name="search" size={16} className="nu-feed-search__icon" />
              <input
                type="search"
                className="nu-feed-search__input"
                data-nu-role="global-feed-search-input"
                placeholder="Search posts, people or #tags"
                aria-label="Search posts"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setSearch('');
                }}
              />
              {search && (
                <button
                  type="button"
                  className="nu-feed-search__clear"
                  data-nu-role="global-feed-search-clear"
                  aria-label="Clear search"
                  onClick={() => setSearch('')}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>

            {searching ? (
              <p className="nu-feed-search__summary" data-nu-role="global-feed-search-summary">
                {query.kind === 'tag' ? (
                  <>
                    Posts tagged <strong>#{query.tag}</strong>
                  </>
                ) : (
                  <>
                    Posts matching <strong>{search.trim()}</strong>
                  </>
                )}{' '}
                in {tab === 'following' ? 'Following' : 'Everyone'}
                {!feed.loading && ` · ${shown.length} found`}
              </p>
            ) : (
              <PostComposer targets={targets} ready={feed.directoryLoaded} placeholder="What’s happening?" onPublished={feed.addSource} />
            )}

            {tab === 'following' && !followsNothing && !searching && (
              <button
                type="button"
                className="nu-global-feed__manage-toggle"
                data-nu-role="global-feed-manage-follows"
                aria-expanded={managing}
                onClick={() => setManaging((m) => !m)}
              >
                <Icon name={managing ? 'chevronDown' : 'chevronRight'} size={14} />
                Following {follows.users.length} {follows.users.length === 1 ? 'person' : 'people'} and {follows.spaces.length}{' '}
                {follows.spaces.length === 1 ? 'space' : 'spaces'}
              </button>
            )}

            {showManager && (
              <section className="nu-global-feed__follows" data-nu-role="global-feed-follows">
                {followsNothing && (
                  <p className="nu-global-feed__follows-intro">
                    Follow whole spaces here, or people from their profile (click any name). Their posts collect in this
                    tab.
                  </p>
                )}
                {follows.users.length > 0 && (
                  <div className="nu-global-feed__follow-group">
                    <h3 className="nu-global-feed__follow-heading">People</h3>
                    {follows.users.map((userId) => (
                      <div className="nu-global-feed__follow-row" key={userId}>
                        <span className="nu-global-feed__follow-name">{nameOfUser(userId)}</span>
                        <button type="button" className="nu-follow-button nu-follow-button--on" onClick={() => toggle('user', userId)}>
                          Following
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="nu-global-feed__follow-group">
                  <h3 className="nu-global-feed__follow-heading">Spaces</h3>
                  {followableSpaces.length === 0 && <p className="nu-global-feed__follows-intro">No spaces to follow yet.</p>}
                  {followableSpaces.map((space) => {
                    const on = follows.spaces.includes(space.roomId);
                    return (
                      <div className="nu-global-feed__follow-row" key={space.roomId}>
                        <span className="nu-global-feed__follow-name">
                          {space.name}
                          {!feed.publicSpaceIds.has(space.roomId) && <span className="nu-global-feed__follow-note"> (members only)</span>}
                        </span>
                        <button
                          type="button"
                          className={on ? 'nu-follow-button nu-follow-button--on' : 'nu-follow-button'}
                          data-nu-role="global-feed-follow-space"
                          aria-pressed={on}
                          onClick={() => toggle('space', space.roomId)}
                        >
                          {on ? 'Following' : 'Follow'}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {followError && <p className="nu-field__error">{followError}</p>}
              </section>
            )}

            {feed.error && (
              <p className="nu-field__error" data-nu-role="global-feed-error">
                {feed.error}
              </p>
            )}

            {newCount > 0 && (
              <button type="button" className="nu-feed__new-posts" data-nu-role="global-feed-new-posts" onClick={showNewPosts}>
                <Icon name="arrowUp" size={14} />
                {newCount === 1 ? '1 new post' : `${newCount} new posts`}
              </button>
            )}

            <GlobalPostList posts={shown} targets={targets} onReposted={feed.addSource} />

            {(feed.loading || feed.loadingMore) && (
              <p className="nu-feed__status" data-nu-role="global-feed-loading">
                {feed.loading ? 'Gathering posts…' : 'Loading older posts…'}
              </p>
            )}
            {!feed.loading && !feed.error && shown.length === 0 && !feed.loadingMore && (
              <p className="nu-feed__status" data-nu-role="global-feed-empty">
                {searching
                  ? feed.hasMore
                    ? 'Nothing found in the posts read so far.'
                    : 'Nothing found.'
                  : tab === 'everyone'
                    ? 'Nothing posted publicly yet. Post to Global and it shows up here.'
                    : followsNothing
                      ? 'You’re not following anyone yet.'
                      : 'Nothing new from the people and spaces you follow.'}
              </p>
            )}
            {searching && searchPaused && feed.hasMore && (
              <button
                type="button"
                className="nu-button nu-button--secondary nu-feed__load-more"
                data-nu-role="global-feed-search-more"
                onClick={() => {
                  searchPagesRef.current = 0;
                  setSearchPaused(false);
                }}
              >
                Search older posts
              </button>
            )}
            {!feed.loading && tab === 'everyone' && !searching && feed.unreadableSpaces > 0 && (
              <p className="nu-global-feed__note" data-nu-role="global-feed-unreadable">
                {feed.unreadableSpaces === 1
                  ? '1 public space isn’t shown because its posts can only be read by its members.'
                  : `${feed.unreadableSpaces} public spaces aren’t shown because their posts can only be read by their members.`}
              </p>
            )}
            {!feed.loading && tab === 'everyone' && feed.directoryTruncated && (
              <p className="nu-global-feed__note" data-nu-role="global-feed-truncated">
                This server has more public profiles and spaces than Everyone reads at once, so some aren’t
                shown here. People and spaces you follow always are.
              </p>
            )}
            {!feed.loading && !feed.hasMore && shown.length > 0 && !searching && (
              <p className="nu-feed__status nu-feed__status--end" data-nu-role="global-feed-end">
                You’re all caught up.
              </p>
            )}
            <div ref={sentinelRef} className="nu-feed__sentinel" aria-hidden="true" />
          </>
        )}
      </div>
    </main>
  );
}

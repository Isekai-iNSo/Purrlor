import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { feedSearchAtom } from '../../app/state/feed';
import { globalFeedOpenAtom, openPostAtom } from '../../app/state/selection';
import type { RepostOf } from '../../matrix/feed';
import { MatrixClientContext } from '../../matrix/MatrixClientContext';
import type { PostComment } from '../../matrix/postInteractions';
import { InteractivePost } from './InteractivePost';

const comment = (i: number, extra: Partial<PostComment> = {}): PostComment => ({
  eventId: `$c${i}`,
  sender: '@bob:x',
  ts: i,
  content: { body: `comment ${i}` },
  ...extra,
});

const firstComment: PostComment = {
  eventId: '$c1',
  sender: '@bob:x',
  ts: 1,
  content: { body: 'first!', attachments: [{ kind: 'image', url: 'mxc://x/a', name: 'a.webp', info: { mimetype: 'image/webp', size: 1 } }] },
};

const hook = {
  likeCount: 2,
  likesTruncated: false,
  likers: ['@bob:x', '@carol:x'],
  repostCount: 0,
  repostsTruncated: false,
  myRepost: undefined as { receiptId: string; roomId: string; eventId: string } | undefined,
  older: undefined as { token: string } | undefined,
  loadingOlder: false,
  loadOlder: vi.fn(async () => undefined),
  myLikeId: undefined as string | undefined,
  comments: [firstComment],
  loaded: true,
  busy: false,
  toggleLike: vi.fn(async () => undefined),
  addComment: vi.fn(async () => undefined),
  removeComment: vi.fn(async () => undefined),
  reload: vi.fn(),
};
vi.mock('../../matrix/hooks/usePostInteractions', () => ({ usePostInteractions: () => hook }));
const publishing = vi.hoisted(() => ({
  repostToTarget: vi.fn(async () => ({
    source: { roomId: '!me', owner: '@me:x', ownerName: 'Me', origin: { kind: 'global' }, isPublic: true },
    eventId: '$repost',
  })),
  undoRepost: vi.fn(async () => undefined),
}));
vi.mock('../../matrix/postPublishing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../matrix/postPublishing')>()),
  ...publishing,
}));
// Media and avatars resolve mxc URLs through the client; nothing here needs them to load.
vi.mock('./PostMedia', () => ({ PostMedia: () => <div data-nu-role="post-media" /> }));
vi.mock('../../components/Avatar', () => ({ Avatar: () => null }));

let ignoredUsers: string[] = [];

const mx = {
  getUserId: () => '@me:x',
  // No feed or Space rooms loaded: not a moderator, and nobody known to have left.
  getRoom: () => null,
  getIgnoredUsers: () => ignoredUsers,
  getAccountData: () => undefined,
  on: vi.fn(),
  removeListener: vi.fn(),
  getProfileInfo: vi.fn(async (userId: string) => ({ displayname: userId === '@bob:x' ? 'Bob' : userId })),
} as never;

function renderPost(props: Partial<Parameters<typeof InteractivePost>[0]> = {}) {
  const store = createStore();
  const view = render(
    <JotaiProvider store={store}>
      <MatrixClientContext.Provider value={mx}>
        <InteractivePost
          roomId="!feed"
          postId="$post"
          sourceOrigin={{ kind: 'global' }}
          isPublic
          canInteract
          content={{ body: 'hello' }}
          author={{ userId: '@alice:x', name: 'Alice' }}
          ts={0}
          myUserId="@me:x"
          {...props}
        />
      </MatrixClientContext.Provider>
    </JotaiProvider>
  );
  return { ...view, store };
}

const q = (container: HTMLElement, role: string) => container.querySelector(`[data-nu-role="${role}"]`) as HTMLElement | null;
/** Opens the ⋯ menu, where the less-used actions live. */
const openMore = (container: HTMLElement) => fireEvent.click(q(container, 'post-more')!);

const repostOf: RepostOf = {
  roomId: '!feed',
  eventId: '$post',
  sender: '@alice:x',
  senderName: 'Alice',
  origin: { kind: 'global' },
  ts: 0,
  body: 'hello',
};
const repost = { repostOf, targets: [{ id: 'global', label: 'Global', isPublic: true, target: { kind: 'global' as const } }] };
const shownComments = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-nu-role="post-comment"] .nu-post__text')).map((n) => n.textContent);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  hook.comments = [firstComment];
  hook.older = undefined;
  hook.likesTruncated = false;
  hook.repostCount = 0;
  hook.myRepost = undefined;
  ignoredUsers = [];
});

describe('InteractivePost', () => {
  it('shows like, comment and repost with their counts', () => {
    const { container } = renderPost({ repost });
    expect(q(container, 'post-like')?.textContent).toBe('2');
    expect(q(container, 'post-comment-toggle')?.textContent).toBe('1');
    expect(q(container, 'post-repost-action')).toBeTruthy();
  });

  it('has no repost button when the post cannot be reposted anywhere', () => {
    const { container } = renderPost();
    expect(q(container, 'post-repost-action')).toBeNull();
  });

  it('offers Report on someone else’s post, never on your own, and no moderator Remove without the power', () => {
    const { container } = renderPost();
    openMore(container);
    expect(q(container, 'post-report')).toBeTruthy();
    expect(q(container, 'post-moderator-remove')).toBeNull();
    fireEvent.click(q(container, 'post-report')!);
    expect(q(container, 'report-dialog')).toBeTruthy();
    cleanup();
    const own = renderPost({ author: { userId: '@me:x', name: 'Me' } });
    openMore(own.container);
    expect(q(own.container, 'post-report')).toBeNull();
  });

  it('lets only the author edit, in place', () => {
    const { container } = renderPost();
    openMore(container);
    expect(q(container, 'post-edit')).toBeNull();
    cleanup();
    const own = renderPost({ author: { userId: '@me:x', name: 'Me' } });
    openMore(own.container);
    fireEvent.click(q(own.container, 'post-edit')!);
    expect((q(own.container, 'post-edit-input') as HTMLTextAreaElement).value).toBe('hello');
    expect(q(own.container, 'post-edit')).toBeNull();
  });

  it('marks an edited post', () => {
    const { container } = renderPost({ edited: true });
    expect(q(container, 'post-edited')).toBeTruthy();
  });

  it('hides a post by someone you have blocked', () => {
    ignoredUsers = ['@alice:x'];
    const { container } = renderPost();
    expect(q(container, 'feed-post')).toBeNull();
  });

  it('hides comments by someone you have blocked', () => {
    ignoredUsers = [firstComment.sender];
    const { container } = renderPost({ mode: 'page' });
    expect(shownComments(container)).toEqual([]);
  });

  it('likes on click', () => {
    const { container } = renderPost();
    fireEvent.click(q(container, 'post-like')!);
    expect(hook.toggleLike).toHaveBeenCalledOnce();
  });

  it('marks counts that have more behind them', () => {
    hook.likesTruncated = true;
    hook.older = { token: 'tok' };
    const { container } = renderPost();
    expect(q(container, 'post-like')?.textContent).toBe('2+');
    expect(q(container, 'post-comment-toggle')?.textContent).toBe('1+');
  });

  it('opens the thread with comments and a reply box that takes media', async () => {
    const { container } = renderPost();
    fireEvent.click(q(container, 'post-comment-toggle')!);
    expect(screen.getByText('first!')).toBeTruthy();
    expect(container.querySelector('[data-nu-role="post-comment"] [data-nu-role="post-media"]')).toBeTruthy();
    expect(q(container, 'post-comment-attach')).toBeTruthy();

    fireEvent.change(q(container, 'post-comment-input')!, { target: { value: 'nice post' } });
    fireEvent.submit(q(container, 'post-comment-form')!);
    await vi.waitFor(() =>
      expect(hook.addComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'nice post' }), undefined)
    );
  });

  it("explains instead of offering a reply box where you can't join the feed", () => {
    const { container } = renderPost({ canInteract: false, cannotInteractReason: 'Join Cats to like or comment.' });
    fireEvent.click(q(container, 'post-comment-toggle')!);
    expect(q(container, 'post-comment-form')).toBeNull();
    expect(q(container, 'post-comment-reply')).toBeNull();
    expect(screen.getByText('Join Cats to like or comment.')).toBeTruthy();
  });

  it("says why Like and Report can't be used there, instead of a tooltip a phone never shows", () => {
    const { container } = renderPost({ canInteract: false, cannotInteractReason: 'Join Cats to like, comment or report.' });
    expect(q(container, 'post-like')?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(q(container, 'post-like')!);
    expect(hook.toggleLike).not.toHaveBeenCalled();
    expect(q(container, 'post-interaction-notice')?.textContent).toBe('Join Cats to like, comment or report.');

    openMore(container);
    fireEvent.click(q(container, 'post-report')!);
    expect(q(container, 'report-dialog')).toBeNull();
  });
});

describe('long threads', () => {
  it('shows only the newest three in a timeline, and links the rest to the post page', () => {
    hook.comments = Array.from({ length: 25 }, (_, i) => comment(i + 1));
    hook.older = { token: 'tok' };
    const { container, store } = renderPost({ origin: { kind: 'global' } });
    fireEvent.click(q(container, 'post-comment-toggle')!);
    expect(shownComments(container)).toEqual(['comment 23', 'comment 24', 'comment 25']);
    expect(q(container, 'post-comments-earlier')).toBeNull();

    const viewAll = q(container, 'post-comments-view-all')!;
    expect(viewAll.textContent).toBe('View all 25+ comments');
    fireEvent.click(viewAll);
    expect(store.get(openPostAtom)).toMatchObject({
      roomId: '!feed',
      postId: '$post',
      showOrigin: true,
      sourceOrigin: { kind: 'global' },
    });
  });

  it('opens the post page from its time', () => {
    const { container, store } = renderPost();
    fireEvent.click(q(container, 'post-open-page')!);
    expect(store.get(openPostAtom)?.postId).toBe('$post');
  });

  it('opens the post page from a tap on its text', () => {
    const { store } = renderPost();
    fireEvent.click(screen.getByText('hello'));
    expect(store.get(openPostAtom)?.postId).toBe('$post');
  });

  it('on the post page, shows the whole thread: newest 50, then earlier, then older from the server', async () => {
    hook.comments = Array.from({ length: 80 }, (_, i) => comment(i + 1));
    hook.older = { token: 'tok' };
    const { container } = renderPost({ mode: 'page' });
    // Always open on its page, with no toggle and no link to itself.
    expect(q(container, 'post-comments')).toBeTruthy();
    expect(q(container, 'post-open-page')).toBeNull();
    expect(shownComments(container)).toHaveLength(50);
    expect(shownComments(container)[49]).toBe('comment 80');

    const earlier = () => q(container, 'post-comments-earlier') as HTMLButtonElement;
    expect(earlier().textContent).toBe('Show earlier comments (30)');
    fireEvent.click(earlier());
    await vi.waitFor(() => expect(shownComments(container)).toHaveLength(80));
    expect(hook.loadOlder).not.toHaveBeenCalled();

    expect(earlier().textContent).toBe('Load earlier comments');
    fireEvent.click(earlier());
    await vi.waitFor(() => expect(hook.loadOlder).toHaveBeenCalledOnce());
  });
});

describe('replies', () => {
  it('replies to a specific comment, naming it as the target', async () => {
    const { container } = renderPost();
    fireEvent.click(q(container, 'post-comment-toggle')!);
    fireEvent.click(q(container, 'post-comment-reply')!);
    await vi.waitFor(() => expect(q(container, 'post-comment-replying')?.textContent).toContain('Replying to Bob'));

    fireEvent.change(q(container, 'post-comment-input')!, { target: { value: 'agreed' } });
    fireEvent.submit(q(container, 'post-comment-form')!);
    await vi.waitFor(() =>
      expect(hook.addComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'agreed' }), {
        eventId: '$c1',
        sender: '@bob:x',
      })
    );
    await vi.waitFor(() => expect(q(container, 'post-comment-replying')).toBeNull());
  });

  it('can cancel a reply and send a plain comment instead', async () => {
    const { container } = renderPost();
    fireEvent.click(q(container, 'post-comment-toggle')!);
    fireEvent.click(q(container, 'post-comment-reply')!);
    fireEvent.click(q(container, 'post-comment-reply-cancel')!);
    fireEvent.change(q(container, 'post-comment-input')!, { target: { value: 'hi all' } });
    fireEvent.submit(q(container, 'post-comment-form')!);
    await vi.waitFor(() => expect(hook.addComment).toHaveBeenCalledWith(expect.objectContaining({ body: 'hi all' }), undefined));
  });

  it('labels a comment that answers another', async () => {
    hook.comments = [firstComment, comment(2, { sender: '@carol:x', replyTo: { eventId: '$c1', sender: '@bob:x' } })];
    const { container } = renderPost();
    fireEvent.click(q(container, 'post-comment-toggle')!);
    await vi.waitFor(() => expect(q(container, 'post-comment-reply-label')?.textContent).toBe('Replying to Bob'));
  });
});

describe('deleting', () => {
  it('asks before deleting your own post', async () => {
    const onDelete = vi.fn(async () => undefined);
    const { container } = renderPost({ author: { userId: '@me:x', name: 'Me' }, onDelete });
    openMore(container);
    fireEvent.click(q(container, 'feed-post-delete')!);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(q(container, 'confirm-cancel')!);
    expect(q(container, 'confirm-dialog')).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    openMore(container);
    fireEvent.click(q(container, 'feed-post-delete')!);
    fireEvent.click(q(container, 'confirm-ok')!);
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
  });

  it('asks before deleting a comment', async () => {
    hook.comments = [comment(1, { sender: '@me:x' })];
    const { container } = renderPost();
    fireEvent.click(q(container, 'post-comment-toggle')!);
    fireEvent.click(q(container, 'post-comment-delete')!);
    expect(hook.removeComment).not.toHaveBeenCalled();
    fireEvent.click(q(container, 'confirm-ok')!);
    await vi.waitFor(() => expect(hook.removeComment).toHaveBeenCalledWith('$c1'));
  });
});

describe('profiles', () => {
  it("opens a commenter's profile from their name", async () => {
    const onOpenProfile = vi.fn();
    const { container } = renderPost({ onOpenProfile });
    fireEvent.click(q(container, 'post-comment-toggle')!);
    await vi.waitFor(() => expect(q(container, 'post-comment-author')?.textContent).toBe('Bob'));
    fireEvent.click(q(container, 'post-comment-author')!);
    expect(onOpenProfile).toHaveBeenCalledWith('@bob:x');
  });
});

describe('reposting', () => {
  it('reposts in one tap, to Global, from the Repost menu', async () => {
    const onReposted = vi.fn();
    const { container } = renderPost({ repost, onReposted });
    fireEvent.click(q(container, 'post-repost-action')!);
    fireEvent.click(q(container, 'post-repost-now')!);
    await vi.waitFor(() => expect(publishing.repostToTarget).toHaveBeenCalledOnce());
    expect(publishing.repostToTarget).toHaveBeenCalledWith(expect.anything(), { kind: 'global' }, repostOf, expect.any(String), true);
    await vi.waitFor(() => expect(onReposted).toHaveBeenCalled());
  });

  it('opens the quote dialog from Quote', () => {
    const { container } = renderPost({ repost });
    fireEvent.click(q(container, 'post-repost-action')!);
    fireEvent.click(q(container, 'post-quote')!);
    expect(q(container, 'repost-dialog')).toBeTruthy();
  });

  it('offers Undo once you have reposted, and shows the count', async () => {
    hook.repostCount = 3;
    hook.myRepost = { receiptId: '$receipt', roomId: '!me', eventId: '$r' };
    const { container } = renderPost({ repost });
    expect(q(container, 'post-repost-action')?.textContent).toBe('3');
    fireEvent.click(q(container, 'post-repost-action')!);
    expect(q(container, 'post-repost-now')).toBeNull();
    fireEvent.click(q(container, 'post-undo-repost')!);
    await vi.waitFor(() => expect(publishing.undoRepost).toHaveBeenCalledWith(expect.anything(), '!feed', hook.myRepost));
  });
});

describe('who liked', () => {
  it('lists the people who liked a post', async () => {
    const { container } = renderPost();
    openMore(container);
    fireEvent.click(q(container, 'post-likers')!);
    await vi.waitFor(() => expect(container.querySelectorAll('[data-nu-role="people-row"]')).toHaveLength(2));
  });

  it('shows like and repost totals on the post page', () => {
    hook.repostCount = 1;
    const { container } = renderPost({ mode: 'page' });
    expect(q(container, 'post-stats')?.textContent).toBe('2 likes1 repost');
  });
});

describe('content warnings and tags', () => {
  it('hides a post behind its warning until asked', () => {
    const { container } = renderPost({ content: { body: 'the ending', warning: 'Spoilers', attachments: [firstComment.content.attachments![0]] } });
    expect(q(container, 'post-warning')?.textContent).toContain('Spoilers');
    expect(screen.queryByText('the ending')).toBeNull();
    expect(q(container, 'post-media')).toBeNull();
    fireEvent.click(q(container, 'post-warning-toggle')!);
    expect(screen.getByText('the ending')).toBeTruthy();
    expect(q(container, 'post-media')).toBeTruthy();
  });

  it('opens a hashtag in the global feed search', () => {
    const { container, store } = renderPost({ content: { body: 'sunny #Caturday' } });
    fireEvent.click(q(container, 'hashtag')!);
    expect(store.get(feedSearchAtom)).toBe('#caturday');
    expect(store.get(globalFeedOpenAtom)).toBe(true);
    expect(store.get(openPostAtom)).toBeNull();
  });
});

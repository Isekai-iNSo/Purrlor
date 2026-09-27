import { useEffect, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { useSetAtom } from 'jotai';
import { openPostAtom } from '../../app/state/selection';
import { useConfirm } from '../../components/ConfirmDialog';
import { Icon } from '../../components/Icon';
import { Menu, MenuItem } from '../../components/Menu';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { buildPostContent, deletePost, editPost, type PostContent, type PostOrigin, type RepostOf } from '../../matrix/feed';
import type { FeedSource } from '../../matrix/globalFeed';
import { buildMessageFormatting } from '../../matrix/messageFormatting';
import { canModerateFeed, isRemovedFromSpace } from '../../matrix/feedGovernance';
import { useIgnoredUsers } from '../../matrix/hooks/useIgnoredUsers';
import { useOwnProfile } from '../../matrix/hooks/useOwnProfile';
import { usePostInteractions } from '../../matrix/hooks/usePostInteractions';
import { forgetLike, recordLike } from '../../matrix/likedPosts';
import { repostToTarget, undoRepost } from '../../matrix/postPublishing';
import { CharCounter, isOverLimit } from './CharCounter';
import { CommentThread } from './CommentThread';
import { membersAsPeople } from '../messaging/useMentionAutocomplete';
import { PeopleListModal } from './PeopleListModal';
import { PostCard } from './PostCard';
import type { ComposerTarget } from './PostComposer';
import { ReportDialog } from './ReportDialog';
import { RepostDialog } from './RepostDialog';
import { GLOBAL_TARGET_ID } from './useComposerTargets';
import { useMyPinnedPost } from './usePinnedPost';

/** A timeline shows at most this many of a post's newest comments; the rest are on its page. */
export const INLINE_COMMENT_LIMIT = 3;

type InteractivePostProps = Omit<ComponentProps<typeof PostCard>, 'actions' | 'footer'> & {
  /** The feed room the post lives in, and its event ID — where likes and comments go. */
  roomId: string;
  postId: string;
  /** Where the post lives — carried to its own page, and to reposts. */
  sourceOrigin: PostOrigin;
  /** Whether that feed is world-readable (Global, a public Space). Comment media is uploaded
   *  plain there and encrypted everywhere else, matching the post's own media. */
  isPublic: boolean;
  /** Liking and commenting join the feed room, which only works where you're allowed in: any
   *  profile feed, but a Space's feeds only if you're in that Space. */
  canInteract: boolean;
  cannotInteractReason?: string;
  /** What reposting this post copies, and where it may go (repostTargetsFor) — absent when it
   *  can't be reposted anywhere you post. */
  repost?: { repostOf: RepostOf; targets: ComposerTarget[] };
  /** After a repost or quote lands in a feed the timeline may not have been reading yet. */
  onReposted?: (source: FeedSource) => void;
  /** Deletes the post, after asking. Only passed for the post's own author. */
  onDelete?: () => Promise<void>;
  /** More owner-only items for the ⋯ menu (Make private), as MenuItems. */
  extraMenuItems?: ReactNode;
  /** `timeline` (default): the thread opens on demand and shows only the newest few comments,
   *  linking to the post's page for the rest. `page`: the post's own page — the whole thread,
   *  always open. */
  mode?: 'timeline' | 'page';
};

/**
 * A post with its likes, comments and repost — the one card the Space Posts page, the global
 * feed, profiles and a post's own page all render, so they can't drift apart.
 */
export function InteractivePost({
  roomId,
  postId,
  sourceOrigin,
  isPublic,
  canInteract,
  cannotInteractReason,
  repost,
  onReposted,
  onDelete,
  extraMenuItems,
  mode = 'timeline',
  ...card
}: InteractivePostProps) {
  const mx = useMatrixClient();
  // Only a feed's owner posts in it, so the post's author is the feed's owner.
  const interactions = usePostInteractions(roomId, postId, card.author.userId, card.ts);
  const setOpenPost = useSetAtom(openPostAtom);
  const onPage = mode === 'page';
  const [open, setOpen] = useState(onPage);
  const [error, setError] = useState<string>();
  // Why Like/Report did nothing — shown in the card, since a tooltip never shows on a phone.
  const [notice, setNotice] = useState<string>();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [reporting, setReporting] = useState<{ eventId: string; what: 'post' | 'comment' }>();
  const [quoting, setQuoting] = useState(false);
  const [reposting, setReposting] = useState(false);
  const [showLikers, setShowLikers] = useState(false);
  const { displayName } = useOwnProfile();
  const { pinned, pin } = useMyPinnedPost();
  const liked = !!interactions.myLikeId;
  const reposted = !!interactions.myRepost;
  const isPostOwner = card.author.userId === card.myUserId;
  // A Space moderator, mirrored into this feed by its owner (feedGovernance.ts).
  const canModerate = !isPostOwner && canModerateFeed(mx.getRoom(roomId), card.myUserId);
  // Someone who has left or been removed from the Space stops showing here at once, even before
  // the feed's owner comes online and removes them from the feed room itself.
  const space = sourceOrigin.kind === 'space' ? mx.getRoom(sourceOrigin.spaceId) : null;
  const ignored = useIgnoredUsers();
  const comments = interactions.comments.filter(
    (comment) => !isRemovedFromSpace(space, comment.sender) && !ignored.has(comment.sender)
  );
  const commentCount = comments.length > 0 ? `${comments.length}${interactions.older ? '+' : ''}` : '';

  // Editing (the author only). What was saved shows at once, until the feed itself catches up:
  // a post's own page holds a snapshot, and a feed you haven't joined doesn't update live.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [saved, setSaved] = useState<PostContent>();
  useEffect(() => setSaved(undefined), [card.content.body]);
  const content = saved ?? card.content;
  const edited = !!card.edited || !!saved;

  const handleSaveEdit = async (evt: FormEvent) => {
    evt.preventDefault();
    const body = draft.trim();
    if (savingEdit || isOverLimit(body) || (!body && !content.attachments?.length && !content.repostOf)) return;
    setSavingEdit(true);
    setError(undefined);
    try {
      const { formattedBody } = buildMessageFormatting(body, card.emotes ?? [], []);
      const next = buildPostContent(body, formattedBody, {
        attachments: content.attachments,
        repostOf: content.repostOf,
        warning: content.warning,
        sensitive: content.sensitive,
      });
      await editPost(mx, roomId, postId, next);
      setSaved(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save that edit');
    } finally {
      setSavingEdit(false);
    }
  };

  const editForm = editing ? (
    <form className="nu-post__edit" data-nu-role="post-edit-form" onSubmit={handleSaveEdit}>
      <textarea
        className="nu-field__textarea"
        data-nu-role="post-edit-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
        rows={3}
        autoFocus
      />
      <div className="nu-form-actions">
        <CharCounter text={draft} />
        <button type="button" className="nu-button nu-button--secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button
          type="submit"
          className="nu-button nu-button--primary"
          data-nu-role="post-edit-save"
          disabled={savingEdit || isOverLimit(draft)}
        >
          {savingEdit ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  ) : undefined;

  const handleRemove = async () => {
    const ok = await confirm({
      title: 'Remove post',
      message: `Remove ${card.author.name}’s post for everyone? This can’t be undone.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    setError(undefined);
    try {
      await deletePost(mx, roomId, postId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t remove that post');
    }
  };

  const openPage = () =>
    setOpenPost({
      roomId,
      postId,
      isPublic,
      canInteract,
      cannotInteractReason,
      content,
      edited,
      author: card.author,
      ts: card.ts,
      sourceOrigin,
      showOrigin: !!card.origin,
      emotes: card.emotes,
      members: card.members,
    });

  const handleDelete = async () => {
    if (!onDelete) return;
    const ok = await confirm({
      title: 'Delete post',
      message: 'Delete this post for everyone? Its likes and comments go with it. This can’t be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setError(undefined);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t delete that post');
    }
  };

  const handleLike = async () => {
    if (!canInteract) {
      setNotice(cannotInteractReason);
      return;
    }
    setError(undefined);
    const wasLiked = liked;
    try {
      await interactions.toggleLike();
      // Filed for your profile's Likes tab (likedPosts.ts). Best-effort: the like itself stands.
      const record = wasLiked
        ? forgetLike(mx, postId)
        : recordLike(mx, {
            roomId,
            eventId: postId,
            owner: card.author.userId,
            ownerName: card.author.name,
            origin: sourceOrigin,
            isPublic,
          });
      void record.catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t update that like');
    }
  };

  // A plain repost goes out at once — to Global when that's allowed, otherwise the one place it
  // may go (the post's own Space). Quote is the dialog, for adding words or picking a place.
  const handleRepost = async () => {
    if (!repost || reposting) return;
    const target = repost.targets.find((t) => t.id === GLOBAL_TARGET_ID) ?? repost.targets[0];
    if (!target) return;
    setReposting(true);
    setError(undefined);
    try {
      const { source } = await repostToTarget(mx, target.target, repost.repostOf, displayName || card.myUserId, target.isPublic);
      onReposted?.(source);
      await interactions.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t repost that');
    } finally {
      setReposting(false);
    }
  };

  const handleUndoRepost = async () => {
    if (!interactions.myRepost || reposting) return;
    setReposting(true);
    setError(undefined);
    try {
      await undoRepost(mx, roomId, interactions.myRepost);
      await interactions.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t undo that repost');
    } finally {
      setReposting(false);
    }
  };

  // Only a post anyone can read can be pinned to your public profile.
  const canPin = isPostOwner && isPublic;
  const isPinned = pinned?.eventId === postId;
  const handlePin = async () => {
    setError(undefined);
    try {
      await pin(isPinned ? null : { roomId, eventId: postId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t update your pinned post');
    }
  };

  const countLabel = (count: number, truncated: boolean) => `${count}${truncated ? '+' : ''}`;

  // Someone you've blocked: their posts go, wherever they're read from.
  if (ignored.has(card.author.userId)) return null;

  return (
    <PostCard
      {...card}
      content={content}
      edited={edited}
      bodyOverride={editForm}
      onOpen={onPage ? undefined : openPage}
      actions={
        <>
          <button
            type="button"
            className={[
              'nu-post__action',
              liked && 'nu-post__action--active',
              !canInteract && 'nu-post__action--unavailable',
            ]
              .filter(Boolean)
              .join(' ')}
            data-nu-role="post-like"
            aria-pressed={liked}
            aria-disabled={!canInteract}
            title={canInteract ? (liked ? 'Unlike' : 'Like') : cannotInteractReason}
            disabled={interactions.busy}
            onClick={() => void handleLike()}
          >
            <Icon name="heart" size={14} filled={liked} />
            {interactions.likeCount > 0 ? `${interactions.likeCount}${interactions.likesTruncated ? '+' : ''}` : 'Like'}
          </button>
          <button
            type="button"
            className={open ? 'nu-post__action nu-post__action--active' : 'nu-post__action'}
            data-nu-role="post-comment-toggle"
            aria-expanded={open}
            // On the post's page the thread is the page; there's nothing to toggle.
            disabled={onPage}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="comment" size={14} />
            {commentCount || 'Comment'}
          </button>
          {(repost || reposted) && (
            <Menu
              label={reposted ? 'Reposted' : 'Repost or quote'}
              role="post-repost-action"
              triggerClassName={reposted ? 'nu-post__action nu-post__action--reposted' : 'nu-post__action'}
              trigger={
                <>
                  <Icon name="repost" size={14} />
                  {interactions.repostCount > 0
                    ? countLabel(interactions.repostCount, interactions.repostsTruncated)
                    : reposted
                      ? 'Reposted'
                      : 'Repost'}
                </>
              }
            >
              {reposted ? (
                <MenuItem icon="repost" role="post-undo-repost" onSelect={() => void handleUndoRepost()}>
                  Undo repost
                </MenuItem>
              ) : (
                <MenuItem icon="repost" role="post-repost-now" onSelect={() => void handleRepost()}>
                  Repost
                </MenuItem>
              )}
              {repost && (
                <MenuItem icon="pencil" role="post-quote" onSelect={() => setQuoting(true)}>
                  Quote
                </MenuItem>
              )}
            </Menu>
          )}
          <Menu
            label="More"
            role="post-more"
            align="end"
            triggerClassName="nu-post__action nu-post__action--more"
            trigger={<Icon name="more" size={16} />}
          >
            {isPostOwner && !editing && (
              <MenuItem
                icon="pencil"
                role="post-edit"
                onSelect={() => {
                  setDraft(content.body);
                  setEditing(true);
                }}
              >
                Edit
              </MenuItem>
            )}
            {canPin && (
              <MenuItem icon="pin" role="post-pin" onSelect={() => void handlePin()}>
                {isPinned ? 'Unpin from profile' : 'Pin to profile'}
              </MenuItem>
            )}
            {extraMenuItems}
            {interactions.likeCount > 0 && (
              <MenuItem icon="heart" role="post-likers" onSelect={() => setShowLikers(true)}>
                See who liked
              </MenuItem>
            )}
            {!isPostOwner && (
              <MenuItem
                icon="flag"
                role="post-report"
                onSelect={() => (canInteract ? setReporting({ eventId: postId, what: 'post' }) : setNotice(cannotInteractReason))}
              >
                Report post
              </MenuItem>
            )}
            {canModerate && (
              <MenuItem icon="shield" role="post-moderator-remove" danger onSelect={() => void handleRemove()}>
                Remove (moderator)
              </MenuItem>
            )}
            {onDelete && (
              <MenuItem icon="trash" role="feed-post-delete" danger onSelect={() => void handleDelete()}>
                Delete
              </MenuItem>
            )}
          </Menu>
        </>
      }
      footer={
        <>
          {confirmDialog}
          {onPage && (interactions.likeCount > 0 || interactions.repostCount > 0) && (
            <p className="nu-post__stats" data-nu-role="post-stats">
              {interactions.likeCount > 0 && (
                <button type="button" className="nu-post__stat" data-nu-role="post-stats-likes" onClick={() => setShowLikers(true)}>
                  <strong>{countLabel(interactions.likeCount, interactions.likesTruncated)}</strong>{' '}
                  {interactions.likeCount === 1 ? 'like' : 'likes'}
                </button>
              )}
              {interactions.repostCount > 0 && (
                <span className="nu-post__stat">
                  <strong>{countLabel(interactions.repostCount, interactions.repostsTruncated)}</strong>{' '}
                  {interactions.repostCount === 1 ? 'repost' : 'reposts'}
                </span>
              )}
            </p>
          )}
          {showLikers && (
            <PeopleListModal
              title="Liked by"
              userIds={interactions.likers}
              emptyText="Nobody has liked this yet."
              {...(interactions.likesTruncated && { note: `Showing the first ${interactions.likers.length}.` })}
              onClose={() => setShowLikers(false)}
            />
          )}
          {quoting && repost && (
            <RepostDialog
              repostOf={repost.repostOf}
              targets={repost.targets}
              onClose={() => setQuoting(false)}
              onReposted={(source) => {
                onReposted?.(source);
                void interactions.reload();
              }}
            />
          )}
          {notice && (
            <p className="nu-post__notice" data-nu-role="post-interaction-notice">
              {notice}
            </p>
          )}
          {reporting && (
            <ReportDialog
              roomId={roomId}
              eventId={reporting.eventId}
              what={reporting.what}
              ownerId={card.author.userId}
              onClose={() => setReporting(undefined)}
            />
          )}
          {error && (
            <p className="nu-field__error" data-nu-role="post-interaction-error">
              {error}
            </p>
          )}
          {open && (
            <CommentThread
              comments={comments}
              isPublic={isPublic}
              canComment={canInteract}
              cannotCommentReason={cannotInteractReason}
              canRemoveAny={isPostOwner || canModerate}
              // Only people in the feed room receive its events, so only they can be mentioned.
              mentionPeople={membersAsPeople(mx.getRoom(roomId)?.getJoinedMembers() ?? []).filter(
                (person) => person.userId !== card.myUserId && !ignored.has(person.userId)
              )}
              {...(canInteract && { onReport: (eventId: string) => setReporting({ eventId, what: 'comment' }) })}
              onOpenProfile={card.onOpenProfile}
              emotes={card.emotes}
              members={card.members}
              onAdd={interactions.addComment}
              onDelete={interactions.removeComment}
              hasOlder={!!interactions.older}
              loadingOlder={interactions.loadingOlder}
              onLoadOlder={interactions.loadOlder}
              {...(!onPage && { inlineLimit: INLINE_COMMENT_LIMIT, onViewAll: openPage, totalLabel: commentCount })}
            />
          )}
        </>
      }
    />
  );
}

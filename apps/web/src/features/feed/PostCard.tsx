import { useState, type MouseEvent, type ReactNode } from 'react';
import type { RoomMember } from 'matrix-js-sdk';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import type { Emote } from '../../matrix/emotes';
import type { PostContent, PostOrigin, RepostOf } from '../../matrix/feed';
import { useIgnoredUsers } from '../../matrix/hooks/useIgnoredUsers';
import { useRepostStatus } from '../../matrix/hooks/useRepostStatus';
import { LinkPreviewCard } from '../messaging/LinkPreviewCard';
import { extractFirstUrl, renderMessageText } from '../messaging/renderMessageText';
import { formatPostTime } from './formatPostTime';
import { PostMedia } from './PostMedia';
import { useOpenHashtag } from './useOpenHashtag';

export type PostAuthor = { userId: string; name: string; avatarUrl?: string | null };

type PostCardProps = {
  content: PostContent;
  author: PostAuthor;
  ts: number;
  /** Where the post lives — shown as a chip when the timeline mixes places. */
  origin?: PostOrigin;
  myUserId: string;
  emotes?: Emote[];
  members?: RoomMember[];
  privateBadge?: boolean;
  /** The author has edited it since posting. */
  edited?: boolean;
  /** Shown in place of the text — the edit box, while the author is editing. */
  bodyOverride?: ReactNode;
  onOpenProfile?: (userId: string) => void;
  /** Opens a Space's posts from its chip. Only Spaces you're in can be opened (see
   *  canOpenOrigin); a Global chip is never a link, since the author's name already is. */
  onOpenOrigin?: (origin: PostOrigin) => void;
  canOpenOrigin?: (origin: PostOrigin) => boolean;
  /** Opens the post on its own page — from its time, or a tap on its text. Absent on that page. */
  onOpen?: () => void;
  actions?: ReactNode;
  /** Below the action row — the comment thread, when it's open. */
  footer?: ReactNode;
  role?: string;
};

function OriginChip({ origin, onOpen }: { origin: PostOrigin; onOpen?: (origin: PostOrigin) => void }) {
  const label = origin.kind === 'global' ? 'Global' : origin.spaceName;
  const className = origin.kind === 'global' ? 'nu-post__origin nu-post__origin--global' : 'nu-post__origin';
  if (!onOpen) {
    return (
      <span className={`${className} nu-post__origin--static`} data-nu-role="post-origin">
        {origin.kind === 'global' && <Icon name="globe" size={11} />}
        {label}
      </span>
    );
  }
  return (
    <button type="button" className={className} data-nu-role="post-origin" title={`Open ${label}`} onClick={() => onOpen(origin)}>
      {origin.kind === 'global' && <Icon name="globe" size={11} />}
      {label}
    </button>
  );
}

function AuthorName({ author, onOpenProfile }: { author: PostAuthor; onOpenProfile?: (userId: string) => void }) {
  if (!onOpenProfile) return <span className="nu-post__author">{author.name}</span>;
  return (
    <button type="button" className="nu-post__author nu-post__author--link" data-nu-role="post-author" onClick={() => onOpenProfile(author.userId)}>
      {author.name}
    </button>
  );
}

/**
 * A content warning: the warning's text, and a button that shows or hides what it covers. Each
 * card remembers its own choice while it's on screen; nothing is remembered past that.
 */
function WarningGate({ warning, children }: { warning?: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  if (!warning) return <>{children}</>;
  return (
    <>
      <div className="nu-post__warning" data-nu-role="post-warning">
        <Icon name="eyeOff" size={14} />
        <span className="nu-post__warning-text">{warning}</span>
        <button
          type="button"
          className="nu-post__warning-toggle"
          data-nu-role="post-warning-toggle"
          aria-expanded={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? 'Show less' : 'Show more'}
        </button>
      </div>
      {shown && children}
    </>
  );
}

/** The first link in a post, unfurled — unless the post has its own media to show instead. */
function PostLinkPreview({ content }: { content: { body: string; attachments?: unknown[] } }) {
  const url = content.attachments?.length ? undefined : extractFirstUrl(content.body);
  return url ? <LinkPreviewCard url={url} /> : null;
}

/**
 * The original inside a repost. The copy travels with the repost, so it's checked against the real
 * post (matrix/repostCheck.ts): a deleted original shows as removed, and a copy that doesn't match
 * isn't shown at all. Until the check answers, and when it can't, the copy shows.
 */
function RepostQuote({
  repost,
  myUserId,
  onOpenProfile,
  openerFor,
}: {
  repost: RepostOf;
  myUserId: string;
  onOpenProfile?: (userId: string) => void;
  openerFor: (target: PostOrigin) => ((origin: PostOrigin) => void) | undefined;
}) {
  const status = useRepostStatus(repost);
  const ignored = useIgnoredUsers();
  const openHashtag = useOpenHashtag();
  if (ignored.has(repost.sender)) {
    return (
      <blockquote className="nu-post__quote nu-post__quote--unavailable" data-nu-role="post-repost-unavailable">
        A post by someone you’ve blocked.
      </blockquote>
    );
  }
  if (status === 'deleted' || status === 'mismatch') {
    return (
      <blockquote className="nu-post__quote nu-post__quote--unavailable" data-nu-role="post-repost-unavailable">
        {status === 'deleted'
          ? 'This post was removed.'
          : 'This repost doesn’t match the original post, so it isn’t shown.'}
      </blockquote>
    );
  }
  return (
    <blockquote className="nu-post__quote" data-nu-role="post-repost">
      <header className="nu-post__meta">
        <AuthorName author={{ userId: repost.sender, name: repost.senderName }} onOpenProfile={onOpenProfile} />
        <OriginChip origin={repost.origin} onOpen={openerFor(repost.origin)} />
        {repost.ts > 0 && <time className="nu-post__time">{formatPostTime(repost.ts)}</time>}
        {status === 'unknown' && (
          <span className="nu-post__badge" data-nu-role="post-repost-unchecked" title="Couldn’t reach the original to check this copy">
            Unchecked
          </span>
        )}
      </header>
      <WarningGate warning={repost.warning}>
        {repost.body && (
          <div className="nu-post__text">{renderMessageText(repost.body, [], [], myUserId, { onHashtag: openHashtag })}</div>
        )}
        {repost.attachments && <PostMedia attachments={repost.attachments} sensitive={repost.sensitive} />}
        <PostLinkPreview content={repost} />
      </WarningGate>
    </blockquote>
  );
}

/**
 * One post: author, where it lives, text, media — and for a repost, the original embedded in a
 * quoted card, readable here even if its own room isn't (the content travels with the repost).
 */
export function PostCard({
  content,
  author,
  ts,
  origin,
  myUserId,
  emotes = [],
  members = [],
  privateBadge,
  edited,
  bodyOverride,
  onOpenProfile,
  onOpenOrigin,
  canOpenOrigin,
  onOpen,
  actions,
  footer,
  role = 'feed-post',
}: PostCardProps) {
  // A tap on the text opens the post, like any social app — except on something that's its own
  // control (a link, a mention, a spoiler) or when the tap was the end of selecting text to copy.
  const openFromText = (evt: MouseEvent) => {
    if (!onOpen) return;
    if ((evt.target as HTMLElement).closest('a, button, input, textarea, [role="button"]')) return;
    if (window.getSelection()?.toString()) return;
    onOpen();
  };
  const time = new Date(ts);
  const openHashtag = useOpenHashtag();

  const repost = content.repostOf;
  const openerFor = (target: PostOrigin) =>
    onOpenOrigin && target.kind === 'space' && (canOpenOrigin?.(target) ?? true) ? onOpenOrigin : undefined;

  return (
    <article className={privateBadge ? 'nu-post nu-post--private' : 'nu-post'} data-nu-role={role}>
      <Avatar name={author.name} mxcUrl={author.avatarUrl ?? null} size={40} />
      <div className="nu-post__body">
        {repost && (
          <div className="nu-post__repost-label" data-nu-role="post-repost-label">
            <Icon name="repost" size={13} />
            Reposted
          </div>
        )}
        <header className="nu-post__meta">
          <AuthorName author={author} onOpenProfile={onOpenProfile} />
          {origin && <OriginChip origin={origin} onOpen={openerFor(origin)} />}
          {privateBadge && (
            <span className="nu-post__badge" data-nu-role="feed-private-badge">
              Only you
            </span>
          )}
          {onOpen ? (
            <button type="button" className="nu-post__time nu-post__time--link" data-nu-role="post-open-page" title={time.toLocaleString()} onClick={onOpen}>
              <time dateTime={time.toISOString()}>{formatPostTime(ts)}</time>
            </button>
          ) : (
            <time className="nu-post__time" dateTime={time.toISOString()} title={time.toLocaleString()}>
              {formatPostTime(ts)}
            </time>
          )}
          {edited && (
            <span className="nu-post__time" data-nu-role="post-edited">
              (edited)
            </span>
          )}
        </header>
        {bodyOverride ?? (
          <WarningGate warning={content.warning}>
            {content.body && (
              // No keyboard handler needed here: the time button is the keyboard route to the same page.
              <div className={onOpen ? 'nu-post__text nu-post__text--openable' : 'nu-post__text'} onClick={openFromText}>
                {renderMessageText(content.body, emotes, members, myUserId, { onHashtag: openHashtag })}
              </div>
            )}
            {content.attachments && <PostMedia attachments={content.attachments} sensitive={content.sensitive} />}
            <PostLinkPreview content={content} />
          </WarningGate>
        )}
        {repost && <RepostQuote repost={repost} myUserId={myUserId} onOpenProfile={onOpenProfile} openerFor={openerFor} />}
        {actions && <div className="nu-post__actions">{actions}</div>}
        {footer}
      </div>
    </article>
  );
}

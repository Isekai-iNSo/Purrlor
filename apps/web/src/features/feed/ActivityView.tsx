import { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { MatrixClient } from 'matrix-js-sdk';
import { activityAtom } from '../../app/state/feed';
import { profileUserIdAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Icon, type IconName } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { markActivitySeen, type ActivityItem, type ActivityKind } from '../../matrix/activity';
import { readPostContent } from '../../matrix/feed';
import { useUserProfile } from '../../matrix/hooks/useUserProfile';
import { formatPostTime } from './formatPostTime';
import { useOpenPost } from './useOpenPost';
import './ActivityView.css';

const ICONS: Record<ActivityKind, IconName> = {
  like: 'heart',
  repost: 'repost',
  quote: 'repost',
  comment: 'comment',
  reply: 'reply',
  mention: 'at',
  follow: 'userPlus',
};

const VERBS: Record<ActivityKind, string> = {
  like: 'liked your post',
  repost: 'reposted your post',
  quote: 'quoted your post',
  comment: 'commented on your post',
  reply: 'replied to you',
  mention: 'mentioned you',
  follow: 'followed you',
};

// A post's or comment's text, read once per session — rows re-render often, the text doesn't
// change (an edit shows on the post itself).
const textCache = new Map<string, Promise<string | undefined>>();

function readEventText(mx: MatrixClient, roomId: string, eventId: string): Promise<string | undefined> {
  const key = `${roomId}|${eventId}`;
  let cached = textCache.get(key);
  if (!cached) {
    const local = mx.getRoom(roomId)?.findEventById(eventId);
    cached = (local ? Promise.resolve(local.getContent()) : mx.fetchRoomEvent(roomId, eventId).then((raw) => raw.content ?? {}))
      .then((content) => {
        const post = readPostContent(content as Record<string, unknown>);
        if (!post) return undefined;
        return post.warning ? `CW: ${post.warning}` : post.body || (post.attachments?.length ? '📷 Media' : undefined);
      })
      .catch(() => undefined);
    textCache.set(key, cached);
  }
  return cached;
}

function useEventText(roomId: string, eventId: string | undefined): string | undefined {
  const mx = useMatrixClient();
  const [text, setText] = useState<string>();
  useEffect(() => {
    if (!eventId) return undefined;
    let cancelled = false;
    void readEventText(mx, roomId, eventId).then((t) => {
      if (!cancelled) setText(t);
    });
    return () => {
      cancelled = true;
    };
  }, [mx, roomId, eventId]);
  return text;
}

function SenderName({ userId }: { userId: string }) {
  return <strong>{useUserProfile(userId).name}</strong>;
}

/** "Ana", "Ana and Bo", "Ana and 3 others". */
function Who({ senders }: { senders: string[] }) {
  if (senders.length === 1) return <SenderName userId={senders[0]} />;
  if (senders.length === 2) {
    return (
      <>
        <SenderName userId={senders[0]} /> and <SenderName userId={senders[1]} />
      </>
    );
  }
  return (
    <>
      <SenderName userId={senders[0]} /> and {senders.length - 1} others
    </>
  );
}

/** What a row quotes: the words themselves for a comment, reply, mention or quote; your own post
 *  for a like or repost; nothing for a follow. */
function snippetTarget(item: ActivityItem): { roomId: string; eventId?: string } {
  switch (item.kind) {
    case 'comment':
    case 'reply':
    case 'mention':
      return { roomId: item.roomId, eventId: item.eventId };
    case 'quote':
      return item.quote ?? { roomId: item.roomId, eventId: item.postId };
    case 'like':
    case 'repost':
      return { roomId: item.roomId, eventId: item.postId };
    default:
      return { roomId: item.roomId };
  }
}

function ActivityRow({ item, unread }: { item: ActivityItem; unread: boolean }) {
  const first = useUserProfile(item.senders[0]);
  const target = snippetTarget(item);
  const text = useEventText(target.roomId, target.eventId);
  const openPost = useOpenPost();
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const quiet = item.kind === 'like' || item.kind === 'repost';

  const open = () => {
    if (item.kind === 'follow') {
      setProfileUserId(item.senders[0]);
    } else if (item.kind === 'quote' && item.quote) {
      // The quote lives in the quoter's feed, which you may not be in; fall back to your post.
      void openPost(item.quote.roomId, item.quote.eventId).then((opened) => {
        if (!opened && item.postId) void openPost(item.roomId, item.postId);
      });
    } else if (item.postId) {
      void openPost(item.roomId, item.postId);
    }
  };

  return (
    <li>
      <button
        type="button"
        className={unread ? 'nu-activity__row nu-activity__row--unread' : 'nu-activity__row'}
        data-nu-role="activity-row"
        data-nu-kind={item.kind}
        onClick={open}
      >
        <span className={`nu-activity__icon nu-activity__icon--${item.kind}`}>
          <Icon name={ICONS[item.kind]} size={16} filled={item.kind === 'like'} />
        </span>
        <span className="nu-activity__body">
          <span className="nu-activity__head">
            <Avatar name={first.name} mxcUrl={first.avatarUrl} size={28} />
            <time className="nu-activity__time" dateTime={new Date(item.ts).toISOString()} title={new Date(item.ts).toLocaleString()}>
              {formatPostTime(item.ts)}
            </time>
          </span>
          <span className="nu-activity__summary">
            <Who senders={item.senders} /> {VERBS[item.kind]}
          </span>
          {text && <span className={quiet ? 'nu-activity__text nu-activity__text--quiet' : 'nu-activity__text'}>{text}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * The global feed's Notifications tab (Activity in the code): what people did with your posts and profile, newest first.
 * Opening it marks everything seen (on every device); what was new when you opened it stays
 * highlighted while you're looking.
 */
export function ActivityView() {
  const mx = useMatrixClient();
  const { items, loaded, seenTs } = useAtomValue(activityAtom);
  // Captured once, so rows don't lose their highlight the instant they're marked seen.
  const [seenAtOpen] = useState(seenTs);
  const newest = items[0]?.ts ?? 0;

  useEffect(() => {
    if (newest > 0) void markActivitySeen(mx, newest).catch(() => undefined);
  }, [mx, newest]);

  if (!loaded) {
    return (
      <p className="nu-feed__status" data-nu-role="activity-loading">
        Checking for notifications…
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="nu-feed__status" data-nu-role="activity-empty">
        Nothing yet. When people like, comment on, repost or quote your posts, follow you, or mention you, it shows up here.
      </p>
    );
  }
  return (
    <ul className="nu-activity" data-nu-role="activity-list">
      {items.map((item) => (
        <ActivityRow key={item.key} item={item} unread={item.ts > seenAtOpen} />
      ))}
    </ul>
  );
}

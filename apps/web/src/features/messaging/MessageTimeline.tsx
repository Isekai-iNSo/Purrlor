import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Direction, type MatrixClient, type MatrixEvent, type Room, type RoomMember } from 'matrix-js-sdk';
import { useAtom } from 'jotai';
import { Avatar, nameHue } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { RoleBadge } from '../../components/RoleBadge';
import { pendingJumpTargetAtom } from '../../app/state/selection';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import type { Emote } from '../../matrix/emotes';
import { usePinnedEventIds } from '../../matrix/hooks/usePinnedEventIds';
import { useReactions, type ReactionGroup } from '../../matrix/hooks/useReactions';
import { useReadReceipts } from '../../matrix/hooks/useReadReceipts';
import { useRoomEmotes } from '../../matrix/hooks/useRoomEmotes';
import { useRoomMembers } from '../../matrix/hooks/useRoomMembers';
import { useRoomTimeline } from '../../matrix/hooks/useRoomTimeline';
import { useSavedMessages } from '../../matrix/hooks/useSavedMessages';
import { useThreads, type ThreadSummary } from '../../matrix/hooks/useThreads';
import { editMessage } from '../../matrix/edits';
import { canRedactEvent, canSendStateEvent } from '../../matrix/permissions';
import { pinMessage, unpinMessage } from '../../matrix/pins';
import { removeReaction, sendReaction } from '../../matrix/reactions';
import { redactMessage } from '../../matrix/redaction';
import { getReplyEventId, type ReplyTarget } from '../../matrix/replies';
import { roleFor } from '../../matrix/roles';
import { saveMessage, unsaveMessage } from '../../matrix/savedMessages';
import { UserProfileModal } from '../profile/UserProfileModal';
import { EditHistoryModal } from './EditHistoryModal';
import { FileMessage } from './FileMessage';
import { ForwardMessageModal } from './ForwardMessageModal';
import { ImageMessage } from './ImageMessage';
import { LinkPreviewCard } from './LinkPreviewCard';
import { ReactionBar } from './ReactionBar';
import { ReactionPicker } from './ReactionPicker';
import { extractFirstUrl, renderMessageText } from './renderMessageText';
import { ThreadPanel } from './ThreadPanel';
import './MessageTimeline.css';

const HISTORY_PAGE_SIZE = 30;
const LOAD_MORE_THRESHOLD_PX = 150;
const PINNED_THRESHOLD_PX = 40;
/** Below this many visible messages on first view, proactively backfill rather than waiting
 *  for the user to discover there's more by scrolling up themselves. */
const THIN_TIMELINE_THRESHOLD = 15;
/** How long after opening/re-opening a room to unconditionally force the bottom, extended by
 *  this much on every further content-size change (see the "settling" effect below). */
const SETTLE_EXTENSION_MS = 500;
/** Hard cap on the above, in case something pathological keeps resizing indefinitely. */
const MAX_SETTLE_MS = 4000;
/** Consecutive same-sender messages within this long of each other collapse into one visual
 *  group (one avatar/name, tightly-spaced lines below it) — matching Discord's own message
 *  grouping, the single biggest reason its timeline reads more compact than one row per message
 *  regardless of font/spacing size. Discord's own threshold isn't publicly documented to the
 *  minute; 5 minutes is a close, reasonable approximation. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** Scrolled further than this from the bottom, the "Jump to latest" button appears. */
const JUMP_BUTTON_THRESHOLD_PX = 400;

function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

/** "Today" / "Yesterday" / "Tuesday, September 23" (plus the year once it isn't this year). */
function dayLabel(ts: number): string {
  const now = Date.now();
  if (isSameDay(ts, now)) return 'Today';
  if (isSameDay(ts, now - 24 * 60 * 60 * 1000)) return 'Yesterday';
  const date = new Date(ts);
  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() !== new Date(now).getFullYear() && { year: 'numeric' }),
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** A labeled rule across the timeline — a new day, or where your unread messages begin. */
function TimelineDivider({ label, variant }: { label: string; variant: 'day' | 'new' }) {
  return (
    <div className={`nu-timeline__divider nu-timeline__divider--${variant}`} data-nu-role={`timeline-divider-${variant}`} role="separator">
      <span className="nu-timeline__divider-label">{label}</span>
    </div>
  );
}

/** What you see once you've scrolled all the way back: the start of the channel, told plainly,
 *  instead of the timeline just running out. */
function ChannelWelcome({ room }: { room: Room }) {
  const topic = room.currentState.getStateEvents('m.room.topic', '')?.getContent<{ topic?: string }>().topic;
  return (
    <div className="nu-timeline__welcome" data-nu-role="timeline-welcome">
      <div className="nu-timeline__welcome-icon" aria-hidden="true">
        <Icon name="hash" size={32} />
      </div>
      <h2 className="nu-timeline__welcome-title">Welcome to #{room.name}</h2>
      <p className="nu-timeline__welcome-text">{topic || `This is the very beginning of #${room.name}.`}</p>
    </div>
  );
}

function previewTextFor(event: MatrixEvent): string {
  const content = event.getContent();
  if (event.getType() === 'm.sticker') return `🎨 ${String(content.body ?? 'Sticker')}`;
  if (content.msgtype === 'm.image') return '📷 Image';
  if (content.msgtype === 'm.video') return '📹 Video';
  if (content.msgtype === 'm.audio') return '🔊 Audio';
  if (content.msgtype === 'm.file') return `📄 ${String(content.body ?? 'File')}`;
  const body = String(content.body ?? '');
  return body.length > 80 ? `${body.slice(0, 80)}…` : body;
}

/** The quoted-preview strip a reply shows above its own body — looks up the original event in
 *  the room's already-loaded events (`room.findEventById`); if it hasn't been loaded (e.g. it's
 *  further back than this session has paginated), shows a plain placeholder rather than fetching
 *  it specially, matching this app's general preference for narrow-but-honest over complete. */
function ReplyPreview({ room, replyEventId }: { room: Room; replyEventId: string }) {
  const original = room.findEventById(replyEventId);
  if (!original) {
    return (
      <div
        className="nu-timeline__reply-preview nu-timeline__reply-preview--missing"
        data-nu-role="timeline-reply-preview"
      >
        ↩ Replying to a message
      </div>
    );
  }
  const senderName = original.sender?.name ?? original.getSender() ?? '?';
  return (
    <div className="nu-timeline__reply-preview" data-nu-role="timeline-reply-preview">
      ↩ <strong>{senderName}</strong>: {previewTextFor(original)}
    </div>
  );
}

function MessageRow({
  mx,
  room,
  event,
  isPinned,
  canPin,
  isHighlighted,
  isGrouped,
  readers,
  emotes,
  reactionGroups,
  saved,
  threadSummary,
  onOpenThread,
  onReply,
  members,
}: {
  mx: MatrixClient;
  room: Room;
  event: MatrixEvent;
  isPinned: boolean;
  canPin: boolean;
  isHighlighted: boolean;
  /** Continuing a burst from the same sender (see GROUP_WINDOW_MS) — renders without its own
   *  avatar/name/time row, just a hover-reveal timestamp in the avatar's usual column, matching
   *  Discord's own message grouping. */
  isGrouped: boolean;
  readers: RoomMember[];
  emotes: Emote[];
  reactionGroups: ReactionGroup[];
  saved: boolean;
  threadSummary?: ThreadSummary;
  onOpenThread: () => void;
  onReply: (target: ReplyTarget) => void;
  members: RoomMember[];
}) {
  const sender = event.sender;
  const senderName = sender?.name ?? event.getSender() ?? '?';
  const senderRole = roleFor(sender?.powerLevel ?? 0).id;
  // event.getContent() already returns the latest m.replace edit's content automatically —
  // matrix-js-sdk aggregates edits onto the original event the same way it aggregates
  // reactions/thread relations (see room.relations, useReactions.ts/useThreads.ts). We just
  // need to know an edit happened at all, for the "(edited)" tag.
  const content = event.getContent();
  const replyEventId = getReplyEventId(event);
  const editedEvent = event.replacingEvent();
  const eventId = event.getId();
  const myUserId = mx.getUserId();
  const isOwnMessage = event.getSender() === myUserId;
  const mentionsMe = !!myUserId && !!content['m.mentions']?.user_ids?.includes(myUserId);
  const isMediaMessage =
    content.msgtype === 'm.image' ||
    content.msgtype === 'm.video' ||
    content.msgtype === 'm.audio' ||
    content.msgtype === 'm.file' ||
    event.getType() === 'm.sticker';
  const isEditable = isOwnMessage && !isMediaMessage && !event.isDecryptionFailure();
  const canDelete = canRedactEvent(room, mx.getUserId() ?? '', event);
  // A local echo (still sending, or sent but not yet confirmed by /sync) has a temporary "~"-
  // prefixed event ID. matrix-js-sdk crashes (`getPendingEvents` requires `pendingEventOrdering:
  // 'detached'`, which this client doesn't use) if you try to target one with a relation event —
  // edit, reply, pin, react, or redact all do exactly that — so those actions stay disabled
  // until event.status clears (see useRoomTimeline.ts's LocalEchoUpdated listener for the
  // re-render that unlocks this the moment it's safe).
  const isPending = event.status !== null;
  // Only plain m.text/m.notice bodies get a preview card — m.emote's body is a third-person
  // action line, not really "a message with a link in it" in the same sense, and media/edit
  // states render their own content instead of this branch at all.
  const firstUrl =
    content.msgtype !== 'm.emote' ? extractFirstUrl(String(content.body ?? '')) : undefined;
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const toggleReaction = (group: ReactionGroup) => {
    if (group.hasOwnReaction) {
      if (group.ownEventId) void removeReaction(mx, room.roomId, group.ownEventId);
    } else if (eventId) {
      void sendReaction(mx, room.roomId, eventId, group.key);
    }
  };

  const startEditing = () => {
    setDraft(String(content.body ?? ''));
    setIsEditing(true);
  };

  const saveEdit = () => {
    const newBody = draft.trim();
    setIsEditing(false);
    if (!eventId || !newBody || newBody === String(content.body ?? '')) return;
    void editMessage(mx, room.roomId, eventId, newBody);
  };

  const [showProfile, setShowProfile] = useState(false);
  const [showEditHistory, setShowEditHistory] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const senderId = event.getSender();

  return (
    <div
      className={[
        'nu-timeline__message',
        isGrouped && 'nu-timeline__message--grouped',
        mentionsMe && 'nu-timeline__message--mentions-me',
        isHighlighted && 'nu-timeline__message--highlighted',
      ]
        .filter(Boolean)
        .join(' ')}
      data-nu-role="timeline-message"
      data-nu-event-id={eventId ?? undefined}
    >
      {isGrouped ? (
        <div className="nu-timeline__message-gutter" data-nu-role="timeline-message-gutter">
          <span className="nu-timeline__message-hover-time">{formatTime(event.getTs())}</span>
        </div>
      ) : (
        <button
          type="button"
          className="nu-timeline__message-avatar"
          data-nu-role="timeline-message-avatar"
          onClick={() => setShowProfile(true)}
        >
          <Avatar name={senderName} mxcUrl={sender?.getMxcAvatarUrl()} size={40} />
        </button>
      )}
      <div className="nu-timeline__message-body">
        {replyEventId && <ReplyPreview room={room} replyEventId={replyEventId} />}
        {(!isGrouped || editedEvent || isPinned) && (
          <div className="nu-timeline__message-meta">
            {!isGrouped && (
              <>
                <button
                  type="button"
                  className={`nu-timeline__message-sender nu-timeline__message-sender--${senderRole}`}
                  data-nu-role="timeline-message-sender"
                  // Staff take their role's color (CSS); everyone else gets a stable per-name
                  // hue matching their fallback avatar, so a busy channel is easy to scan.
                  style={senderRole === 'member' ? { color: `hsl(${nameHue(senderName)}, 70%, 78%)` } : undefined}
                  onClick={() => setShowProfile(true)}
                >
                  {senderName}
                </button>
                <RoleBadge roleId={senderRole} />
                <time className="nu-timeline__message-time" dateTime={new Date(event.getTs()).toISOString()} title={new Date(event.getTs()).toLocaleString()}>
                  {isSameDay(event.getTs(), Date.now()) ? formatTime(event.getTs()) : `${new Date(event.getTs()).toLocaleDateString()} ${formatTime(event.getTs())}`}
                </time>
              </>
            )}
            {editedEvent && (
              <button
                type="button"
                className="nu-timeline__message-edited-tag"
                data-nu-role="timeline-edited-tag"
                title={`Edited ${new Date(editedEvent.getTs()).toLocaleString()} — click to see edit history`}
                onClick={() => setShowEditHistory(true)}
              >
                (edited)
              </button>
            )}
            {isPinned && (
              <span className="nu-timeline__message-pinned-tag" data-nu-role="timeline-pinned-tag">
                <Icon name="pin" size={11} />
                Pinned
              </span>
            )}
          </div>
        )}
        {isEditing ? (
          <div className="nu-timeline__edit-form" data-nu-role="timeline-edit-form">
            <textarea
              className="nu-timeline__edit-input"
              data-nu-role="timeline-edit-input"
              value={draft}
              autoFocus
              rows={1}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                } else if (e.key === 'Escape') {
                  setIsEditing(false);
                }
              }}
            />
            <div className="nu-timeline__edit-hint">Esc to cancel, Enter to save</div>
          </div>
        ) : event.isDecryptionFailure() ? (
          <div className="nu-timeline__message-text">[unable to decrypt]</div>
        ) : event.getType() === 'm.sticker' ? (
          <ImageMessage
            body={String(content.body ?? '')}
            url={content.url}
            file={content.file}
            mimetype={content.info?.mimetype}
            width={content.info?.w}
            height={content.info?.h}
          />
        ) : content.msgtype === 'm.image' ? (
          <ImageMessage
            body={String(content.body ?? '')}
            url={content.url}
            file={content.file}
            mimetype={content.info?.mimetype}
            width={content.info?.w}
            height={content.info?.h}
          />
        ) : content.msgtype === 'm.video' || content.msgtype === 'm.audio' || content.msgtype === 'm.file' ? (
          <FileMessage
            msgtype={content.msgtype}
            body={String(content.body ?? '')}
            url={content.url}
            file={content.file}
            mimetype={content.info?.mimetype}
            size={content.info?.size}
          />
        ) : content.msgtype === 'm.emote' ? (
          <div className="nu-timeline__message-text nu-timeline__message-text--emote">
            * {senderName} {renderMessageText(String(content.body ?? ''), emotes, members, myUserId ?? undefined)}
          </div>
        ) : (
          <>
            <div className="nu-timeline__message-text">
              {renderMessageText(String(content.body ?? ''), emotes, members, myUserId ?? undefined)}
            </div>
            {firstUrl && <LinkPreviewCard url={firstUrl} />}
          </>
        )}
        <ReactionBar groups={reactionGroups} onToggle={toggleReaction} />
        {threadSummary && (
          <button
            type="button"
            className="nu-timeline__message-thread-summary"
            data-nu-role="timeline-thread-summary"
            onClick={onOpenThread}
          >
            <Icon name="threads" size={14} />
            <strong>
              {threadSummary.replyCount} {threadSummary.replyCount === 1 ? 'reply' : 'replies'}
            </strong>
            {threadSummary.lastReplySenderName && (
              <span className="nu-timeline__message-thread-last">Last from {threadSummary.lastReplySenderName}</span>
            )}
          </button>
        )}
        {readers.length > 0 && (
          <div className="nu-timeline__message-readers" data-nu-role="timeline-readers" title={readers.map((r) => r.name).join(', ')}>
            {readers.slice(0, 5).map((reader) => (
              <Avatar key={reader.userId} name={reader.name} mxcUrl={reader.getMxcAvatarUrl()} size={14} />
            ))}
          </div>
        )}
      </div>
      {!event.isDecryptionFailure() && eventId && !isEditing && !isPending && (
        <div className="nu-timeline__message-actions" data-nu-role="timeline-message-actions">
          <ReactionPicker onPick={(key) => void sendReaction(mx, room.roomId, eventId, key)} />
          <button
            type="button"
            className="nu-timeline__message-pin-action"
            data-nu-role="timeline-reply-action"
            title="Reply"
            aria-label="Reply"
            onClick={() => onReply({ eventId, senderName, preview: previewTextFor(event) })}
          >
            <Icon name="reply" size={16} />
          </button>
          <button
            type="button"
            className="nu-timeline__message-pin-action"
            data-nu-role="timeline-thread-action"
            title="Reply in thread"
            aria-label="Reply in thread"
            onClick={onOpenThread}
          >
            <Icon name="threads" size={16} />
          </button>
          <button
            type="button"
            className="nu-timeline__message-pin-action"
            data-nu-role="timeline-forward-action"
            title="Forward"
            aria-label="Forward"
            onClick={() => setShowForward(true)}
          >
            <Icon name="forward" size={16} />
          </button>
          <button
            type="button"
            className="nu-timeline__message-pin-action"
            data-nu-role="timeline-save-action"
            title={saved ? 'Remove from saved' : 'Save message'}
            aria-label={saved ? 'Remove from saved' : 'Save message'}
            aria-pressed={saved}
            onClick={() => void (saved ? unsaveMessage(mx, room.roomId, eventId) : saveMessage(mx, room.roomId, eventId))}
          >
            <Icon name="bookmark" size={16} filled={saved} />
          </button>
          {isEditable && (
            <button
              type="button"
              className="nu-timeline__message-pin-action"
              data-nu-role="timeline-edit-action"
              title="Edit"
              aria-label="Edit"
              onClick={startEditing}
            >
              <Icon name="pencil" size={16} />
            </button>
          )}
          {canPin && (
            <button
              type="button"
              className="nu-timeline__message-pin-action"
              data-nu-role="timeline-pin-action"
              title={isPinned ? 'Unpin' : 'Pin'}
              aria-label={isPinned ? 'Unpin' : 'Pin'}
              aria-pressed={isPinned}
              onClick={() => void (isPinned ? unpinMessage(mx, room, eventId) : pinMessage(mx, room, eventId))}
            >
              <Icon name="pin" size={16} filled={isPinned} />
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="nu-timeline__message-pin-action nu-timeline__message-delete-action"
              data-nu-role="timeline-delete-action"
              title="Delete"
              aria-label="Delete"
              onClick={() => void redactMessage(mx, room.roomId, eventId)}
            >
              <Icon name="trash" size={16} />
            </button>
          )}
        </div>
      )}
      {showProfile && senderId && (
        <UserProfileModal
          userId={senderId}
          displayName={senderName}
          avatarMxcUrl={sender?.getMxcAvatarUrl()}
          onClose={() => setShowProfile(false)}
        />
      )}
      {showEditHistory && (
        <EditHistoryModal roomId={room.roomId} event={event} onClose={() => setShowEditHistory(false)} />
      )}
      {showForward && <ForwardMessageModal event={event} onClose={() => setShowForward(false)} />}
    </div>
  );
}

/**
 * Renders `m.room.message` events, with image messages inline, pin/unpin, read receipts,
 * reactions, threads, and in-place edits (`m.replace` — aggregated onto the original event by
 * matrix-js-sdk itself, see `event.replacingEvent()`/`getContent()` in MessageRow; own messages
 * get an inline "Edit" action, see `matrix/edits.ts`). Consecutive same-sender messages within
 * GROUP_WINDOW_MS collapse into one visual group (MessageRow's `isGrouped`), Discord-style.
 */
export function MessageTimeline({ roomId, onReply }: { roomId: string; onReply: (target: ReplyTarget) => void }) {
  const mx = useMatrixClient();
  const events = useRoomTimeline(roomId);
  const pinnedIds = usePinnedEventIds(roomId);
  const readReceipts = useReadReceipts(roomId);
  const reactions = useReactions(roomId);
  const threads = useThreads(roomId);
  const members = useRoomMembers(roomId);
  const savedMessages = useSavedMessages();
  const savedEventIds = new Set(savedMessages.filter((item) => item.roomId === roomId).map((item) => item.eventId));
  const [openThreadRootId, setOpenThreadRootId] = useState<string | null>(null);
  const [pendingJump, setPendingJump] = useAtom(pendingJumpTargetAtom);
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [atStart, setAtStart] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // Where your read receipt sat when you opened the room — captured once per room visit, before
  // this view marks everything read, so the "New" divider stays put while you read past it
  // instead of vanishing the instant the room opens.
  const [readMarkerEventId, setReadMarkerEventId] = useState<string | null>(null);

  // "Is the user currently at the bottom" — used only to decide whether a *new* message should
  // pull the view down while a room is already open and settled. It is deliberately NOT trusted
  // to decide the position when a room is first opened/re-opened: swapping a room's entire
  // content can itself trigger the browser's own scroll-position clamping (the old scrollTop
  // may no longer be valid for the new content's height), which fires ordinary 'scroll' events
  // indistinguishable from a real user scroll — and that was corrupting this value before our
  // own snap-to-bottom logic ever got to run, which is why it kept landing in a consistent
  // wrong spot on every revisit rather than varying. Opening a room always forces the bottom
  // instead, the same way Discord does regardless of where you left off.
  const pinnedToBottomRef = useRef(true);
  // The first message visible at the top of the viewport, and how far below the container's top
  // edge it sat — refreshed on every scroll. When not pinned to the bottom, any change in content
  // height (older messages prepended, an image above you finishing its fetch+decrypt) restores
  // that message to the same spot, so nothing you're looking at moves. This is our own stand-in
  // for the browser's scroll anchoring, which the CSS turns off (overflow-anchor: none) so it
  // can't fight the stay-at-the-bottom logic.
  const anchorRef = useRef<{ eventId: string; offset: number } | null>(null);
  const autoBackfillDoneRef = useRef(false);
  const roomEnteredAtRef = useRef(0);
  const forceBottomUntilRef = useRef(0);

  const room = mx.getRoom(roomId);
  const emotes = useRoomEmotes(room ?? undefined);
  const canPin = room ? canSendStateEvent(room, mx.getUserId() ?? '', 'm.room.pinned_events') : false;
  const pinnedIdSet = new Set(pinnedIds);

  const messages = events.filter((event) => {
    if (event.isRedacted()) return false;
    if (event.isDecryptionFailure()) return true;
    if (event.getType() === 'm.sticker') return true;
    if (event.getType() !== 'm.room.message') return false;
    const relType = event.getContent()['m.relates_to']?.rel_type;
    // Thread replies render inside their thread's panel only (ThreadPanel), not inline here too
    // — same convention Element uses. Their fallback m.in_reply_to is what non-thread-aware
    // clients render instead; we don't need it since we do support threads.
    return relType !== 'm.replace' && relType !== 'm.thread';
  });

  useEffect(() => {
    const now = Date.now();
    // A pending jump (from search) targets an exact message, not the bottom — don't fight it
    // with the usual "always open a room at the bottom" behavior.
    const jumpingHere = pendingJump?.roomId === roomId;
    pinnedToBottomRef.current = !jumpingHere;
    anchorRef.current = null;
    autoBackfillDoneRef.current = false;
    roomEnteredAtRef.current = now;
    forceBottomUntilRef.current = jumpingHere ? 0 : now + SETTLE_EXTENSION_MS;
    setAtStart(false);
    setShowJumpToLatest(false);
    const myUserId = mx.getUserId();
    setReadMarkerEventId(myUserId ? mx.getRoom(roomId)?.getEventReadUpTo(myUserId) ?? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Marks the room read by sending an `m.read` receipt for the newest message — this app
  // previously never sent one at all (only ever *displayed* other members' receipts, see
  // useReadReceipts.ts), which also meant unread/notification counts server-side never cleared.
  // Fires on opening a room (pinnedToBottomRef starts true on every room switch, see above) and
  // again whenever a new message arrives while still scrolled to the bottom — but not while
  // scrolled up reading history, matching Element's own behavior of not marking-read content
  // you haven't actually scrolled to.
  const lastMessageId = messages[messages.length - 1]?.getId();
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || !pinnedToBottomRef.current) return;
    mx.sendReadReceipt(lastMessage).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, roomId, lastMessageId]);

  const loadMore = async () => {
    const currentRoom = mx.getRoom(roomId);
    const container = containerRef.current;
    if (!currentRoom || !container || loadingMore || atStart) return;
    setLoadingMore(true);
    try {
      await mx.scrollback(currentRoom, HISTORY_PAGE_SIZE);
      if (currentRoom.getLiveTimeline().getPaginationToken(Direction.Backward) === null) {
        setAtStart(true);
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const captureAnchor = () => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    const top = container.getBoundingClientRect().top;
    for (const el of Array.from(content.querySelectorAll<HTMLElement>('[data-nu-event-id]'))) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > top) {
        anchorRef.current = { eventId: el.dataset.nuEventId ?? '', offset: rect.top - top };
        return;
      }
    }
    anchorRef.current = null;
  };

  // Called after anything that may have changed the content's height: while the room is still
  // settling in, or the user is pinned to the bottom, follow the bottom; otherwise put the
  // anchored message back where it was.
  const keepScrollPosition = () => {
    const container = containerRef.current;
    if (!container) return;

    const now = Date.now();
    const stillSettling = now < forceBottomUntilRef.current && now - roomEnteredAtRef.current < MAX_SETTLE_MS;
    if (stillSettling) {
      forceBottomUntilRef.current = Math.min(now + SETTLE_EXTENSION_MS, roomEnteredAtRef.current + MAX_SETTLE_MS);
    }

    if (stillSettling || pinnedToBottomRef.current) {
      container.scrollTop = container.scrollHeight;
    } else if (anchorRef.current) {
      const el = container.querySelector<HTMLElement>(`[data-nu-event-id="${CSS.escape(anchorRef.current.eventId)}"]`);
      if (el) {
        const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
        container.scrollTop += offset - anchorRef.current.offset;
      }
    }
    captureAnchor();
  };

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    captureAnchor();

    if (container.scrollTop < LOAD_MORE_THRESHOLD_PX) {
      void loadMore();
    }

    // Ignore scroll noise while a room is still settling in — see the big comment above.
    if (Date.now() < forceBottomUntilRef.current) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < PINNED_THRESHOLD_PX;
    setShowJumpToLatest(distanceFromBottom > JUMP_BUTTON_THRESHOLD_PX);
  };

  const jumpToLatest = () => {
    pinnedToBottomRef.current = true;
    setShowJumpToLatest(false);
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  };

  // Resolves a pending jump target (from search — see pendingJumpTargetAtom): scroll to and
  // highlight the message once it's actually rendered, backfilling further back if it's older
  // than what this room view has loaded so far, and giving up once scrollback hits the start of
  // the room. A thread reply can never render in this main list (see the `messages` filter
  // above), so those open the reply's thread panel instead of trying to scroll to it here.
  useEffect(() => {
    if (!pendingJump || pendingJump.roomId !== roomId) return;
    const target = room?.findEventById(pendingJump.eventId);
    if (!target) {
      if (!atStart && !loadingMore) void loadMore();
      return;
    }
    if (target.getContent()['m.relates_to']?.rel_type === 'm.thread') {
      const rootId = target.threadRootId ?? target.getContent()['m.relates_to']?.event_id;
      if (rootId) setOpenThreadRootId(rootId);
      setPendingJump(null);
      return;
    }
    const el = containerRef.current?.querySelector(`[data-nu-event-id="${CSS.escape(pendingJump.eventId)}"]`);
    if (el) {
      // Jumping within an already-open room never goes through the room-switch reset effect
      // above (roomId hasn't changed), so pinnedToBottomRef is still whatever it was before —
      // left true, the very next resize-driven re-render (an avatar/image finishing its
      // fetch, say) would snap the view straight back to the bottom, undoing the jump.
      pinnedToBottomRef.current = false;
      el.scrollIntoView({ block: 'center' });
      // Re-anchor now rather than waiting on the scroll event: a resize landing first would
      // otherwise restore the pre-jump anchor and undo the jump.
      captureAnchor();
      setHighlightedEventId(pendingJump.eventId);
      setPendingJump(null);
    } else if (!atStart && !loadingMore) {
      void loadMore();
    } else {
      setPendingJump(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJump, roomId, room, messages.length, atStart, loadingMore]);

  useEffect(() => {
    if (!highlightedEventId) return undefined;
    const timer = setTimeout(() => setHighlightedEventId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightedEventId]);

  // A freshly-synced room can start with a thin initial timeline — the homeserver's sync only
  // sends a limited backlog per room. Back-fill proactively the first time a room's view is
  // thin, rather than requiring the user to scroll up once just to discover there's more.
  useEffect(() => {
    if (autoBackfillDoneRef.current || atStart || loadingMore) return;
    if (messages.length >= THIN_TIMELINE_THRESHOLD) return;
    autoBackfillDoneRef.current = true;
    void loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, atStart, loadingMore]);

  // A new or prepended page of messages: runs before paint, so an older page landing above you
  // (or a new message below while pinned) never shows a frame in the wrong spot.
  useLayoutEffect(() => {
    keepScrollPosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // Everything else that changes the timeline's rendered height after the fact — an avatar
  // finishing its fetch, an image or video finishing its fetch+decrypt, a link preview arriving.
  // While still within this room-view's settle window (forceBottomUntilRef) it snaps to the
  // bottom unconditionally and keeps extending that window for as long as content keeps
  // changing size; after that it follows the bottom only if the user is pinned there, and
  // otherwise holds the anchored message in place. It used to skip every resize while a
  // scrollback was in flight — and opening an image-heavy room almost always starts one (few
  // messages → thin-timeline backfill) — so the images loading meanwhile pushed the view up.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;

    // keepScrollPosition only reads refs, so this first render's copy stays correct.
    const observer = new ResizeObserver(() => keepScrollPosition());

    observer.observe(content);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  if (!room) return null;

  // The "New" divider goes above the first message after your old read marker — unless
  // everything after it is your own (you replied, so you've obviously seen what came before).
  const myUserId = mx.getUserId();
  const markerIndex = readMarkerEventId ? messages.findIndex((event) => event.getId() === readMarkerEventId) : -1;
  const firstUnreadIndex =
    markerIndex >= 0 && messages.slice(markerIndex + 1).some((event) => event.getSender() !== myUserId) ? markerIndex + 1 : -1;

  return (
    <div className="nu-timeline" data-nu-role="timeline" ref={containerRef} onScroll={handleScroll}>
      {loadingMore && (
        <div className="nu-timeline__loading" data-nu-role="timeline-loading">
          Loading more…
        </div>
      )}
      <div className="nu-timeline__content" ref={contentRef}>
        {atStart && <ChannelWelcome room={room} />}
        {messages.map((event, index) => {
          const prevEvent = messages[index - 1];
          const newDay = !prevEvent || !isSameDay(prevEvent.getTs(), event.getTs());
          const isFirstUnread = index === firstUnreadIndex;
          const isGrouped =
            !!prevEvent &&
            !newDay &&
            !isFirstUnread &&
            prevEvent.getSender() === event.getSender() &&
            !getReplyEventId(event) &&
            event.getTs() - prevEvent.getTs() < GROUP_WINDOW_MS;
          return (
            // A message you send starts as a local echo with a temporary ID, which changes when
            // the server confirms it; keyed on that ID, the row remounted then and flickered. The
            // transaction ID stays put on the same event object across the switch.
            <Fragment key={event.getTxnId() ?? event.getId()}>
            {newDay && <TimelineDivider variant="day" label={dayLabel(event.getTs())} />}
            {isFirstUnread && <TimelineDivider variant="new" label="New" />}
            <MessageRow
              mx={mx}
              room={room}
              event={event}
              isPinned={pinnedIdSet.has(event.getId() ?? '')}
              canPin={canPin}
              isHighlighted={!!event.getId() && event.getId() === highlightedEventId}
              isGrouped={isGrouped}
              readers={readReceipts.get(event.getId() ?? '') ?? []}
              emotes={emotes}
              reactionGroups={reactions.get(event.getId() ?? '') ?? []}
              saved={savedEventIds.has(event.getId() ?? '')}
              threadSummary={threads.get(event.getId() ?? '')}
              onOpenThread={() => setOpenThreadRootId(event.getId() ?? null)}
              onReply={onReply}
              members={members}
            />
            </Fragment>
          );
        })}
      </div>
      <div ref={bottomRef} />
      {showJumpToLatest && (
        <div className="nu-timeline__jump-anchor">
          <button
            type="button"
            className="nu-timeline__jump"
            data-nu-role="timeline-jump-to-latest"
            onClick={jumpToLatest}
          >
            <Icon name="arrowDown" size={16} />
            Jump to latest
          </button>
        </div>
      )}
      {openThreadRootId &&
        (() => {
          const rootEvent = room.findEventById(openThreadRootId);
          return rootEvent ? (
            <ThreadPanel
              room={room}
              rootEvent={rootEvent}
              emotes={emotes}
              onClose={() => setOpenThreadRootId(null)}
            />
          ) : null;
        })()}
    </div>
  );
}

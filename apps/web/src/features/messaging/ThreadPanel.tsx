import type { MatrixEvent, Room, RoomMember } from 'matrix-js-sdk';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/Modal';
import type { Emote } from '../../matrix/emotes';
import { useRoomMembers } from '../../matrix/hooks/useRoomMembers';
import { useThreadEvents } from '../../matrix/hooks/useThreads';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { Composer } from './Composer';
import { renderMessageText } from './renderMessageText';
import './ThreadPanel.css';

function ThreadEventRow({
  event,
  emotes,
  members,
  myUserId,
}: {
  event: MatrixEvent;
  emotes: Emote[];
  members: RoomMember[];
  myUserId?: string;
}) {
  const sender = event.sender;
  const senderName = sender?.name ?? event.getSender() ?? '?';
  return (
    <div className="nu-thread-panel__message" data-nu-role="thread-message">
      <Avatar name={senderName} mxcUrl={sender?.getMxcAvatarUrl()} size={24} />
      <div className="nu-thread-panel__message-body">
        <div className="nu-thread-panel__message-meta">
          <span className="nu-thread-panel__message-sender">{senderName}</span>
          <span className="nu-thread-panel__message-time">
            {new Date(event.getTs()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        <div className="nu-thread-panel__message-text">
          {renderMessageText(String(event.getContent().body ?? ''), emotes, members, myUserId)}
        </div>
      </div>
    </div>
  );
}

/**
 * Shows a message's thread (Matrix's `m.thread` relation — matrix-js-sdk's own `Thread` model,
 * see useThreads.ts) as a modal: the root message, its replies in order, and a composer that
 * sends further replies into the same thread. Opened either from a specific message's own 🧵
 * action (MessageTimeline.tsx) or by picking one from the channel-wide list
 * (ThreadsOverviewModal.tsx) — this component doesn't care which. Deliberately narrow scope like
 * the rest of this pass — no reactions or pinning on thread replies.
 */
export function ThreadPanel({
  room,
  rootEvent,
  emotes,
  onClose,
}: {
  room: Room;
  rootEvent: MatrixEvent;
  emotes: Emote[];
  onClose: () => void;
}) {
  const mx = useMatrixClient();
  const members = useRoomMembers(room.roomId);
  const rootEventId = rootEvent.getId() ?? null;
  // Thread.events includes the root event itself as its first entry (it's the thread's own
  // opening message) — already shown above via `rootEvent`, so exclude it here to avoid
  // rendering it twice.
  const replies = useThreadEvents(room, rootEventId).filter((event) => event.getId() !== rootEventId);

  return (
    <Modal title="Thread" onClose={onClose} wide>
      <div className="nu-thread-panel">
        <ThreadEventRow event={rootEvent} emotes={emotes} members={members} myUserId={mx.getUserId() ?? undefined} />
        <div className="nu-thread-panel__divider">
          {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </div>
        <div className="nu-thread-panel__replies" data-nu-role="thread-replies">
          {replies.map((event) => (
            <ThreadEventRow
              // Stable across a sent reply's local-echo → server ID switch (see MessageTimeline).
              key={event.getTxnId() ?? event.getId()}
              event={event}
              emotes={emotes}
              members={members}
              myUserId={mx.getUserId() ?? undefined}
            />
          ))}
        </div>
        {rootEventId && <Composer roomId={room.roomId} threadId={rootEventId} />}
      </div>
    </Modal>
  );
}

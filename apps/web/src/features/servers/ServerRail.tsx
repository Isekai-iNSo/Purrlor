import { useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { activityAtom } from '../../app/state/feed';
import type { Room } from 'matrix-js-sdk';
import { globalFeedOpenAtom, profileUserIdAtom, selectedRoomIdAtom, selectedSpaceIdAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { UnreadBadge } from '../../components/UnreadBadge';
import { DiscoverModal } from '../discover/DiscoverModal';
import { InvitesModal } from '../invites/InvitesModal';
import { MentionInboxModal } from '../mentions/MentionInboxModal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { useMediaUrl } from '../../matrix/hooks/useMediaUrl';
import { useInvites } from '../../matrix/hooks/useInvites';
import { useMentionInbox } from '../../matrix/hooks/useMentionInbox';
import { useSpaceRooms } from '../../matrix/hooks/useSpaceRooms';
import { useSpacelessRooms } from '../../matrix/hooks/useSpacelessRooms';
import { useSpaces } from '../../matrix/hooks/useSpaces';
import { useUnreadSummary } from '../../matrix/hooks/useUnreadCounts';
import { classifyInvite } from '../../matrix/invites';
import { getParentSpace } from '../../matrix/voice';
import { CreateSpaceModal } from './CreateSpaceModal';
import './ServerRail.css';

/** The selected tile's cat ears — drawn on every tile, shown only on the active one (CSS),
 *  so selecting a space animates them in rather than mounting a new element. */
function CatEars() {
  return (
    <svg className="nu-server-rail__ears" viewBox="0 0 48 14" aria-hidden="true" focusable="false">
      <path className="nu-server-rail__ear" d="M4 14 9.5 1.5 19 14z" />
      <path className="nu-server-rail__ear-inner" d="M8.5 14 10.3 7.5 14.6 14z" />
      <path className="nu-server-rail__ear" d="M29 14 38.5 1.5 44 14z" />
      <path className="nu-server-rail__ear-inner" d="M33.4 14 37.7 7.5 39.5 14z" />
    </svg>
  );
}

function ServerRailItem({ space, active, onSelect }: { space: Room; active: boolean; onSelect: () => void }) {
  const src = useMediaUrl(space.getMxcAvatarUrl(), { width: 96, height: 96, method: 'crop' });
  const unread = useUnreadSummary(useSpaceRooms(space.roomId));

  const className = ['nu-server-rail__item', active && 'nu-server-rail__item--active', unread.total > 0 && 'nu-server-rail__item--unread']
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={className}
      data-nu-role="server-rail-item"
      title={space.name}
      aria-label={space.name}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      <CatEars />
      {src ? (
        <img className="nu-server-rail__item-image" src={src} alt="" />
      ) : (
        (space.name || '?').slice(0, 1).toUpperCase()
      )}
      <span className="nu-server-rail__item-badge">
        <UnreadBadge total={unread.total} highlight={unread.highlight} />
      </span>
    </button>
  );
}

/** Left icon rail — one icon per joined Matrix Space, mapped to a Discord "server". */
export function ServerRail() {
  const mx = useMatrixClient();
  const spaces = useSpaces();
  const invites = useInvites();
  const mentions = useMentionInbox();
  const [selectedSpaceId, setSelectedSpaceId] = useAtom(selectedSpaceIdAtom);
  const [, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const [globalFeedOpen, setGlobalFeedOpen] = useAtom(globalFeedOpenAtom);
  const activity = useAtomValue(activityAtom);
  const activityUnread = activity.items.some((item) => item.ts > activity.seenTs);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const [showCreateSpace, setShowCreateSpace] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const dmUnread = useUnreadSummary(useSpacelessRooms());

  const selectSpace = (id: string | null) => {
    setGlobalFeedOpen(false);
    setProfileUserId(null);
    setSelectedSpaceId(id);
    setSelectedRoomId(null);
  };

  const handleInviteAccepted = (room: Room) => {
    const kind = classifyInvite(mx, room);
    if (kind === 'space') {
      selectSpace(room.roomId);
    } else if (kind === 'channel') {
      const parentId = getParentSpace(mx, room)?.roomId ?? null;
      setSelectedSpaceId(parentId);
      setSelectedRoomId(room.roomId);
    } else {
      setSelectedSpaceId(null);
      setSelectedRoomId(room.roomId);
    }
  };

  return (
    <nav className="nu-server-rail" data-nu-role="server-rail">
      <button
        type="button"
        className={
          selectedSpaceId === null && !globalFeedOpen
            ? 'nu-server-rail__item nu-server-rail__item--home nu-server-rail__item--active'
            : 'nu-server-rail__item nu-server-rail__item--home'
        }
        data-nu-role="server-rail-home"
        title="Direct Messages"
        aria-label="Direct Messages"
        onClick={() => selectSpace(null)}
      >
        <CatEars />
        <Icon name="paw" size={24} />
        <span className="nu-server-rail__item-badge">
          <UnreadBadge total={dmUnread.total} highlight={dmUnread.highlight} />
        </span>
      </button>
      <button
        type="button"
        className={
          globalFeedOpen
            ? 'nu-server-rail__item nu-server-rail__item--global-feed nu-server-rail__item--active'
            : 'nu-server-rail__item nu-server-rail__item--global-feed'
        }
        data-nu-role="server-rail-global-feed"
        title="Global feed"
        aria-label="Global feed"
        aria-current={globalFeedOpen ? 'page' : undefined}
        onClick={() => {
          setProfileUserId(null);
          setGlobalFeedOpen(true);
        }}
      >
        <CatEars />
        <Icon name="globe" size={22} />
        {/* New likes, comments, reposts, follows or mentions waiting in Activity. */}
        {activityUnread && <span className="nu-server-rail__item-dot" data-nu-role="server-rail-activity-dot" aria-label="New notifications" />}
      </button>
      <div className="nu-server-rail__divider" />
      <div className="nu-server-rail__list" data-nu-role="server-rail-list">
        {spaces.map((space) => (
          <ServerRailItem
            key={space.roomId}
            space={space}
            active={selectedSpaceId === space.roomId && !globalFeedOpen}
            onSelect={() => selectSpace(space.roomId)}
          />
        ))}
      </div>
      <div className="nu-server-rail__divider" />
      <button
        type="button"
        className="nu-server-rail__item nu-server-rail__item--mentions"
        data-nu-role="server-rail-mentions"
        title="Mentions"
        aria-label="Mentions"
        onClick={() => setShowMentions(true)}
      >
        <Icon name="at" size={20} />
        <span className="nu-server-rail__item-badge">
          <UnreadBadge total={mentions.length} highlight={mentions.length} />
        </span>
      </button>
      <button
        type="button"
        className="nu-server-rail__item nu-server-rail__item--invites"
        data-nu-role="server-rail-invites"
        title="Invites"
        aria-label="Invites"
        onClick={() => setShowInvites(true)}
      >
        <Icon name="mail" size={20} />
        <span className="nu-server-rail__item-badge">
          <UnreadBadge total={invites.length} highlight={invites.length} />
        </span>
      </button>
      <button
        type="button"
        className="nu-server-rail__item nu-server-rail__item--discover"
        data-nu-role="server-rail-discover"
        title="Discover public spaces and channels"
        aria-label="Discover"
        onClick={() => setShowDiscover(true)}
      >
        <Icon name="compass" size={20} />
      </button>
      <button
        type="button"
        className="nu-server-rail__item nu-server-rail__item--add"
        data-nu-role="server-rail-add"
        title="Create a Space"
        aria-label="Create a Space"
        onClick={() => setShowCreateSpace(true)}
      >
        <Icon name="plus" size={20} />
      </button>
      {showCreateSpace && (
        <CreateSpaceModal
          onClose={() => setShowCreateSpace(false)}
          onCreated={(roomId) => {
            setShowCreateSpace(false);
            selectSpace(roomId);
          }}
        />
      )}
      {showDiscover && (
        <DiscoverModal
          onClose={() => setShowDiscover(false)}
          onJoinedSpace={(roomId) => selectSpace(roomId)}
          onJoinedRoom={(roomId) => {
            setSelectedSpaceId(null);
            setSelectedRoomId(roomId);
          }}
        />
      )}
      {showInvites && (
        <InvitesModal
          onClose={() => setShowInvites(false)}
          onAccepted={(room) => {
            setShowInvites(false);
            handleInviteAccepted(room);
          }}
        />
      )}
      {showMentions && <MentionInboxModal onClose={() => setShowMentions(false)} />}
    </nav>
  );
}

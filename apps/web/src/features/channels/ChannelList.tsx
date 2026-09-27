import { useEffect, useState } from 'react';
import { NowPlayingCard } from '../voice/NowPlayingCard';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { Room } from 'matrix-js-sdk';
import {
  activeVoiceChannelIdAtom,
  selectedRoomIdAtom,
  selectedSpaceIdAtom,
  selectedSpaceViewAtom,
  globalFeedOpenAtom,
  profileUserIdAtom,
} from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { UnreadBadge } from '../../components/UnreadBadge';
import { useHasNewPosts } from '../../matrix/hooks/useHasNewPosts';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { reorderCategoryChannels, type ChannelCategory } from '../../matrix/channelCategories';
import { useChannelCategories } from '../../matrix/hooks/useChannelCategories';
import { useChannelType } from '../../matrix/hooks/useChannelType';
import { usePresence } from '../../matrix/hooks/usePresence';
import { useRoom } from '../../matrix/hooks/useRoom';
import { useRoomUnreadCount, useUnreadSummary } from '../../matrix/hooks/useUnreadCounts';
import { useSpaceHierarchy, type HierarchyChannel } from '../../matrix/hooks/useSpaceHierarchy';
import { useSpaceRooms } from '../../matrix/hooks/useSpaceRooms';
import { useSpacelessRooms } from '../../matrix/hooks/useSpacelessRooms';
import { useSpaceVoiceServer } from '../../matrix/hooks/useSpaceVoiceServer';
import { useVoiceChannelParticipants } from '../../matrix/hooks/useVoiceChannelParticipants';
import type { VoiceServerConfig } from '../../matrix/voice';
import { autoJoinSpaceChannels } from '../../matrix/autoJoin';
import { joinPublicRoom } from '../../matrix/directory';
import { canSendStateEvent } from '../../matrix/permissions';
import { isDemoMode } from '../../demo/demoMode';
import { adoptDefaultVoiceServer } from '../../matrix/deploymentDefaults';
import { addVoiceHints, removeRoomFromSpace, reorderSpaceChildren } from '../../matrix/spaceChildren';
import { useVoiceCall } from '../voice/voiceCallContext';
import { UserPanel } from '../account/UserPanel';
import { AddExistingChannelModal } from './AddExistingChannelModal';
import { CreateChannelModal } from './CreateChannelModal';
import { SpaceCard } from './SpaceCard';
import { StartDmModal } from './StartDmModal';
import { SpaceSettingsModal } from '../servers/SpaceSettingsModal';
import './ChannelList.css';

/** For a genuine 1:1 DM (exactly one other joined member), the person on the other end — used
 *  to show a presence dot the way a DM list normally would. Group chats skip it: there's no
 *  single "other person" to represent with one dot. */
function useDmCounterpart(room: Room, isDirectMessage: boolean): string | undefined {
  const mx = useMatrixClient();
  if (!isDirectMessage) return undefined;
  const myUserId = mx.getUserId();
  const others = room.getJoinedMembers().filter((member) => member.userId !== myUserId);
  return others.length === 1 ? others[0].userId : undefined;
}

/** Who's actually connected to a voice channel right now, shown as a short indented list
 *  under its row — the occupancy indicator the README long flagged as deferred. */
function VoiceChannelOccupants({ room, voiceServer }: { room: Room; voiceServer: VoiceServerConfig | undefined }) {
  const participants = useVoiceChannelParticipants(room.roomId, voiceServer);

  if (participants.length === 0) return null;

  return (
    <ul className="nu-channel-list__occupants" data-nu-role="channel-list-occupants">
      {participants.map(({ identity, micMuted, deafened }) => {
        const member = room.getMember(identity);
        const name = member?.name || identity;
        return (
          <li key={identity} className="nu-channel-list__occupant">
            <Avatar name={name} mxcUrl={member?.getMxcAvatarUrl() ?? null} size={16} />
            <span className="nu-channel-list__occupant-name">{name}</span>
            {micMuted && (
              <span className="nu-channel-list__occupant-icon" aria-label="Muted" title="Muted">
                <Icon name="micOff" size={13} />
              </span>
            )}
            {deafened && (
              <span className="nu-channel-list__occupant-icon" aria-label="Deafened" title="Deafened">
                <Icon name="headphonesOff" size={13} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ChannelListRow({
  room,
  isDirectMessage,
  active,
  voiceServer,
  onSelect,
  canManageSpace,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onRemoveFromSpace,
}: {
  room: Room;
  isDirectMessage: boolean;
  active: boolean;
  voiceServer: VoiceServerConfig | undefined;
  onSelect: () => void;
  canManageSpace: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemoveFromSpace: () => void;
}) {
  const counterpartId = useDmCounterpart(room, isDirectMessage);
  const presence = usePresence(counterpartId ?? '');
  const channelType = useChannelType(room);
  const setActiveVoiceChannelId = useSetAtom(activeVoiceChannelIdAtom);
  const unread = useRoomUnreadCount(room);
  const isUnread = unread.total > 0;

  const handleSelect = () => {
    onSelect();
    // Clicking a voice channel joins it immediately — Discord's model, no separate "Join
    // voice" click required when you're getting there via the channel list.
    if (channelType === 'voice') setActiveVoiceChannelId(room.roomId);
  };

  return (
    <div className="nu-channel-list__row">
      <button
        type="button"
        className={['nu-channel-list__item', active && 'nu-channel-list__item--active', isUnread && 'nu-channel-list__item--unread']
          .filter(Boolean)
          .join(' ')}
        data-nu-role="channel-list-item"
        aria-current={active ? 'page' : undefined}
        onClick={handleSelect}
      >
        {isDirectMessage ? (
          <Avatar
            name={room.name}
            mxcUrl={room.getMxcAvatarUrl()}
            size={20}
            presence={counterpartId ? presence ?? 'offline' : undefined}
          />
        ) : (
          <span className="nu-channel-list__item-icon" aria-hidden="true">
            <Icon name={channelType === 'voice' ? 'volume' : 'hash'} size={18} />
          </span>
        )}
        <span className={isUnread ? 'nu-channel-list__item-name nu-channel-list__item-name--unread' : 'nu-channel-list__item-name'}>
          {room.name}
        </span>
        <UnreadBadge total={unread.total} highlight={unread.highlight} />
      </button>
      {!isDirectMessage && canManageSpace && (
        <div className="nu-channel-list__row-actions" data-nu-role="channel-list-row-actions">
          <button
            type="button"
            className="nu-channel-list__row-action"
            data-nu-role="channel-list-move-up"
            title="Move up"
            aria-label="Move up"
            disabled={!canMoveUp}
            onClick={onMoveUp}
          >
            <Icon name="arrowUp" size={13} />
          </button>
          <button
            type="button"
            className="nu-channel-list__row-action"
            data-nu-role="channel-list-move-down"
            title="Move down"
            aria-label="Move down"
            disabled={!canMoveDown}
            onClick={onMoveDown}
          >
            <Icon name="arrowDown" size={13} />
          </button>
          <button
            type="button"
            className="nu-channel-list__row-action"
            data-nu-role="channel-list-remove-from-space"
            title="Remove from Space"
            aria-label="Remove from Space"
            onClick={onRemoveFromSpace}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
      {!isDirectMessage && channelType === 'voice' && (
        <VoiceChannelOccupants room={room} voiceServer={voiceServer} />
      )}
    </div>
  );
}

/**
 * A channel that exists in the Space's hierarchy (`GET /rooms/{spaceId}/hierarchy`) but isn't
 * one of this client's already-known/joined rooms — otherwise entirely invisible, since every
 * other list here (`useSpaceRooms`) only ever sees children it already has a local `Room` object
 * for. Text/voice can't be told apart before joining (the hierarchy summary doesn't carry this
 * app's custom `xyz.nekous.channel_type` state event), so every row gets a plain "#" regardless —
 * resolves to the right icon automatically once joined and rendered as a normal ChannelListRow.
 */
function UnjoinedChannelRow({ entry, onJoined }: { entry: HierarchyChannel; onJoined: (roomId: string) => void }) {
  const mx = useMatrixClient();
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string>();
  const name = entry.name || entry.canonical_alias || entry.room_id;

  const handleJoin = async () => {
    setJoining(true);
    setError(undefined);
    try {
      const roomId = await joinPublicRoom(mx, entry.canonical_alias || entry.room_id);
      onJoined(roomId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join');
      setJoining(false);
    }
  };

  return (
    <div className="nu-channel-list__unjoined-row" data-nu-role="channel-list-unjoined-row" title={error}>
      <span className="nu-channel-list__item-icon" aria-hidden="true">
        <Icon name="hash" size={18} />
      </span>
      <span className="nu-channel-list__unjoined-name">{name}</span>
      <button
        type="button"
        className="nu-channel-list__unjoined-join"
        data-nu-role="channel-list-unjoined-join"
        disabled={joining}
        onClick={handleJoin}
      >
        {joining ? 'Joining…' : error ? 'Retry' : 'Join'}
      </button>
    </div>
  );
}

/**
 * Joins every channel listed under "More channels" that doesn't need an invite — for a Space you
 * were in before joining a Space started joining its channels for you (matrix/autoJoin.ts).
 * Includes channels you once left: clicking this asks for all of them.
 */
function JoinAllButton({ spaceId, count }: { spaceId: string; count: number }) {
  const mx = useMatrixClient();
  const [joining, setJoining] = useState(false);
  const [failed, setFailed] = useState(false);
  if (count < 2) return null;
  return (
    <button
      type="button"
      className="nu-channel-list__join-all"
      data-nu-role="channel-list-join-all"
      disabled={joining}
      title={failed ? 'Some channels couldn’t be joined. They may need an invite.' : `Join all ${count} channels`}
      onClick={() => {
        setJoining(true);
        setFailed(false);
        autoJoinSpaceChannels(mx, spaceId, { includeLeft: true })
          .then((joined) => setFailed(joined.length < count))
          .catch(() => setFailed(true))
          .finally(() => setJoining(false));
      }}
    >
      {joining ? 'Joining…' : 'Join all'}
    </button>
  );
}

/** Persistent bar showing the active voice call regardless of what's selected/viewed — lets
 *  you mute/deafen/leave while looking at an unrelated text channel instead of the call UI.
 *
 *  Shown for every stage of a call, not just a connected one: a join that's still negotiating
 *  (or that failed) is just as much "the channel you're currently in", and hiding the bar until
 *  `ready` meant navigating away mid-connect left no indication a call was in progress at all —
 *  and no way to abandon a failed one without going back to find the channel by hand. */
function ActiveCallBar() {
  const call = useVoiceCall();
  const room = useRoom(call?.roomId ?? null);
  const setSelectedRoomId = useSetAtom(selectedRoomIdAtom);

  if (!call || call.state.status === 'idle' || !room) return null;

  const status = call.state.status;
  const label =
    status === 'ready' ? room.name : status === 'error' ? `${room.name} — couldn't connect` : `${room.name} — connecting…`;

  return (
    <div
      className="nu-channel-list__active-call"
      data-nu-role="active-call-bar"
      data-nu-call-status={status}
    >
      <button
        type="button"
        className="nu-channel-list__active-call-info"
        onClick={() => setSelectedRoomId(room.roomId)}
        title={status === 'ready' ? `Back to call in ${label}` : label}
      >
        <span className={`nu-channel-list__active-call-status nu-channel-list__active-call-status--${status}`}>
          {status === 'ready' ? 'Voice connected' : status === 'error' ? 'Couldn’t connect' : 'Connecting…'}
        </span>
        <span className="nu-channel-list__active-call-name">{room.name}</span>
      </button>
      <button
        type="button"
        className="nu-channel-list__active-call-leave"
        onClick={call.leave}
        title="Leave voice"
        aria-label="Leave voice"
      >
        <Icon name="phoneOff" size={18} />
      </button>
    </div>
  );
}

/** A category's collapsible header. Collapsed, it still owes you a signal: an unread dot if any
 *  channel inside has something new, and how many channels it's hiding. */
function CategoryHeader({
  name,
  rooms,
  collapsed,
  onToggle,
}: {
  name: string;
  rooms: Room[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const unread = useUnreadSummary(rooms);
  return (
    <button
      type="button"
      className={collapsed ? 'nu-channel-list__category-header nu-channel-list__category-header--collapsed' : 'nu-channel-list__category-header'}
      data-nu-role="channel-list-category-header"
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <Icon name="chevronDown" size={12} className="nu-channel-list__category-arrow" />
      <span className="nu-channel-list__category-name">{name}</span>
      {collapsed && (
        <span className="nu-channel-list__category-count">
          {unread.total > 0 && <span className="nu-channel-list__category-unread" aria-label="Unread" />}
          {rooms.length}
        </span>
      )}
    </button>
  );
}

/** Which categories are collapsed, per-Space — purely local display state (not synced to other
 *  members or even this account's other devices, unlike the categories themselves), persisted
 *  to localStorage the same lightweight way theme.ts persists the custom-theme override. */
function useCollapsedCategories(spaceId: string | null): [Set<string>, (categoryId: string) => void] {
  const storageKey = spaceId ? `nekous_collapsed_categories:${spaceId}` : null;

  const readStored = (key: string | null): Set<string> => {
    if (!key) return new Set();
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  };

  const [collapsed, setCollapsed] = useState<Set<string>>(() => readStored(storageKey));

  useEffect(() => {
    setCollapsed(readStored(storageKey));
     
  }, [storageKey]);

  const toggle = (categoryId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          // Best-effort — a full/blocked localStorage just means collapse state won't survive
          // a reload, not that toggling it right now should fail.
        }
      }
      return next;
    });
  };

  return [collapsed, toggle];
}

/** Spaces whose voice links this session has already checked (see the effect in ChannelList). */
const voiceHintedSpaces = new Set<string>();
/** Spaces already offered this deployment's voice server this session (deploymentDefaults.ts). */
const voiceDefaultedSpaces = new Set<string>();

/**
 * Second column. Two modes, toggled by the server rail's pinned Home/DM icon
 * (selectedSpaceId === null): the Direct Messages list (1:1s and group chats alike — see
 * useSpacelessRooms), or the selected Space's channels.
 */
export function ChannelList() {
  const mx = useMatrixClient();
  const selectedSpaceId = useAtomValue(selectedSpaceIdAtom);
  const [selectedRoomId, setSelectedRoomId] = useAtom(selectedRoomIdAtom);
  const [spaceView, setSpaceView] = useAtom(selectedSpaceViewAtom);
  const setGlobalFeedOpen = useSetAtom(globalFeedOpenAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const space = useRoom(selectedSpaceId);
  const newPosts = useHasNewPosts(space ?? null);
  const spaceRooms = useSpaceRooms(selectedSpaceId);
  const categories = useChannelCategories(space);
  const [collapsedCategories, toggleCategoryCollapsed] = useCollapsedCategories(selectedSpaceId);
  const directMessages = useSpacelessRooms();
  const hierarchy = useSpaceHierarchy(selectedSpaceId);
  const joinedChannelIds = new Set(spaceRooms.map((r) => r.roomId));
  // A channel you're already invited to (not just a discoverable stranger channel) gets a real
  // Accept/Decline through the Invites flow instead — no need to also list it here with a plain
  // Join button that skips past the "who invited you" context that flow has.
  const unjoinedChannels = hierarchy.filter(
    (entry) => !joinedChannelIds.has(entry.room_id) && mx.getRoom(entry.room_id)?.getMyMembership() !== 'invite'
  );
  const voiceServer = useSpaceVoiceServer(space);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showSpaceSettings, setShowSpaceSettings] = useState(false);
  const [showStartDm, setShowStartDm] = useState(false);
  const [showAddExistingChannel, setShowAddExistingChannel] = useState(false);

  // Picking a channel also leaves the Posts view, which sits alongside channels rather than
  // being one of them — otherwise the feed would stay on screen over a channel that now looks
  // selected in this list.
  const selectChannel = (roomId: string) => {
    setSelectedRoomId(roomId);
    setSpaceView(null);
    setGlobalFeedOpen(false);
    setProfileUserId(null);
  };

  const isDirectMessagesView = selectedSpaceId === null;
  const canManageSpace = space ? canSendStateEvent(space, mx.getUserId() ?? '', 'm.room.name') : false;
  const canLinkChannels = space ? canSendStateEvent(space, mx.getUserId() ?? '', 'm.space.child') : false;

  // Voice channels made before their Space link said "voice" get the marker the first time an
  // admin opens the Space, so the voice bot can find and join them (spaceChildren.ts).
  useEffect(() => {
    if (!space || !canLinkChannels || voiceHintedSpaces.has(space.roomId)) return;
    voiceHintedSpaces.add(space.roomId);
    addVoiceHints(mx, space, spaceRooms).catch(() => voiceHintedSpaces.delete(space.roomId));
  }, [mx, space, canLinkChannels, spaceRooms]);

  // A Space on a fresh install gets this deployment's voice server the first time an admin opens
  // it, so voice channels just work — nobody has to find and paste the LiveKit URLs.
  useEffect(() => {
    if (!space || isDemoMode() || voiceDefaultedSpaces.has(space.roomId)) return;
    voiceDefaultedSpaces.add(space.roomId);
    adoptDefaultVoiceServer(mx, space).catch(() => voiceDefaultedSpaces.delete(space.roomId));
  }, [mx, space]);

  // A channel belongs to at most one category (Discord's own model) — anything not listed in
  // any category's channelIds renders flat, above the categories, exactly like every Space
  // looked before categories existed (see channelCategories.ts).
  const categorizedIds = new Set(categories.flatMap((c) => c.channelIds));
  const uncategorizedRooms = spaceRooms.filter((r) => !categorizedIds.has(r.roomId));
  const roomById = new Map(spaceRooms.map((r) => [r.roomId, r]));
  const categoryRooms = categories.map((category) => ({
    category,
    // A category can reference a channel that's since been removed from the Space entirely
    // (deleteCategory-style — membership is derived from listing, not a back-reference kept in
    // sync) — filter those out rather than rendering a dead row.
    rooms: category.channelIds.map((id) => roomById.get(id)).filter((r): r is Room => !!r),
  }));

  const handleMoveInUncategorized = (index: number, direction: -1 | 1) => {
    if (!space) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= uncategorizedRooms.length) return;
    const newOrder = uncategorizedRooms.map((r) => r.roomId);
    [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];
    reorderSpaceChildren(mx, space, newOrder).catch(console.error);
  };

  const handleMoveInCategory = (category: ChannelCategory, rooms: Room[], index: number, direction: -1 | 1) => {
    if (!space) return;
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= rooms.length) return;
    const newOrder = rooms.map((r) => r.roomId);
    [newOrder[index], newOrder[targetIndex]] = [newOrder[targetIndex], newOrder[index]];
    reorderCategoryChannels(mx, space, category.id, newOrder).catch(console.error);
  };

  const handleRemoveFromSpace = (roomId: string) => {
    if (!selectedSpaceId) return;
    removeRoomFromSpace(mx, selectedSpaceId, roomId).catch(console.error);
    if (selectedRoomId === roomId) setSelectedRoomId(null);
  };

  return (
    <aside className="nu-channel-list" data-nu-role="channel-list">
      {!isDirectMessagesView && space ? (
        <SpaceCard
          space={space}
          canManageSpace={canManageSpace}
          onOpenSettings={() => setShowSpaceSettings(true)}
          onAddExisting={() => setShowAddExistingChannel(true)}
          onCreateChannel={() => setShowCreateChannel(true)}
        />
      ) : (
        <div className="nu-channel-list__header" data-nu-role="channel-list-header">
          <span className="nu-channel-list__header-title">{isDirectMessagesView ? 'Direct messages' : 'Select a space'}</span>
          {isDirectMessagesView && (
            <button
              type="button"
              className="nu-channel-list__header-action"
              data-nu-role="channel-list-start-dm"
              title="Start a direct message"
              aria-label="Start a direct message"
              onClick={() => setShowStartDm(true)}
            >
              <Icon name="plus" size={16} />
            </button>
          )}
        </div>
      )}
      <div className="nu-channel-list__body" data-nu-role="channel-list-body">
        {isDirectMessagesView
          ? directMessages.map((room) => (
              <ChannelListRow
                key={room.roomId}
                room={room}
                isDirectMessage
                active={selectedRoomId === room.roomId}
                voiceServer={voiceServer}
                onSelect={() => selectChannel(room.roomId)}
                canManageSpace={false}
                canMoveUp={false}
                canMoveDown={false}
                onMoveUp={() => {}}
                onMoveDown={() => {}}
                onRemoveFromSpace={() => {}}
              />
            ))
          : (
              <>
                <div className="nu-channel-list__row">
                  <button
                    type="button"
                    className={['nu-channel-list__item', spaceView === 'feed' && 'nu-channel-list__item--active', newPosts && 'nu-channel-list__item--unread']
                      .filter(Boolean)
                      .join(' ')}
                    data-nu-role="channel-list-feed"
                    onClick={() => {
                      setGlobalFeedOpen(false);
                      setProfileUserId(null);
                      setSpaceView('feed');
                    }}
                  >
                    <span className="nu-channel-list__item-icon" aria-hidden="true">
                      <Icon name="posts" size={18} />
                    </span>
                    <span className={newPosts ? 'nu-channel-list__item-name nu-channel-list__item-name--unread' : 'nu-channel-list__item-name'}>
                      Posts
                    </span>
                    {/* Someone posted since you last looked (matrix/postsSeen.ts). */}
                    <UnreadBadge total={newPosts ? 1 : 0} highlight={0} />
                  </button>
                </div>
                {uncategorizedRooms.map((room, index) => (
                  <ChannelListRow
                    key={room.roomId}
                    room={room}
                    isDirectMessage={false}
                    active={selectedRoomId === room.roomId}
                    voiceServer={voiceServer}
                    onSelect={() => selectChannel(room.roomId)}
                    canManageSpace={canManageSpace}
                    canMoveUp={index > 0}
                    canMoveDown={index < uncategorizedRooms.length - 1}
                    onMoveUp={() => handleMoveInUncategorized(index, -1)}
                    onMoveDown={() => handleMoveInUncategorized(index, 1)}
                    onRemoveFromSpace={() => handleRemoveFromSpace(room.roomId)}
                  />
                ))}
                {categoryRooms.map(({ category, rooms }) => (
                  <div key={category.id} className="nu-channel-list__category">
                    <CategoryHeader
                      name={category.name}
                      rooms={rooms}
                      collapsed={collapsedCategories.has(category.id)}
                      onToggle={() => toggleCategoryCollapsed(category.id)}
                    />
                    {!collapsedCategories.has(category.id) &&
                      rooms.map((room, index) => (
                        <ChannelListRow
                          key={room.roomId}
                          room={room}
                          isDirectMessage={false}
                          active={selectedRoomId === room.roomId}
                          voiceServer={voiceServer}
                          onSelect={() => selectChannel(room.roomId)}
                          canManageSpace={canManageSpace}
                          canMoveUp={index > 0}
                          canMoveDown={index < rooms.length - 1}
                          onMoveUp={() => handleMoveInCategory(category, rooms, index, -1)}
                          onMoveDown={() => handleMoveInCategory(category, rooms, index, 1)}
                          onRemoveFromSpace={() => handleRemoveFromSpace(room.roomId)}
                        />
                      ))}
                  </div>
                ))}
                {unjoinedChannels.length > 0 && (
                  <div className="nu-channel-list__category" data-nu-role="channel-list-unjoined-section">
                    <div className="nu-channel-list__section-header nu-channel-list__section-header--with-action">
                      More channels
                      {selectedSpaceId && <JoinAllButton spaceId={selectedSpaceId} count={unjoinedChannels.length} />}
                    </div>
                    {unjoinedChannels.map((entry) => (
                      <UnjoinedChannelRow
                        key={entry.room_id}
                        entry={entry}
                        onJoined={selectChannel}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
        {isDirectMessagesView && directMessages.length === 0 && (
          <div className="nu-channel-list__empty" data-nu-role="channel-list-empty">
            No conversations yet. Use + above to message someone.
          </div>
        )}
        {!isDirectMessagesView && selectedSpaceId && spaceRooms.length === 0 && (
          <div className="nu-channel-list__empty" data-nu-role="channel-list-empty">
            No channels yet. Use + on the card above to create one.
          </div>
        )}
      </div>
      <NowPlayingCard />
      <ActiveCallBar />
      <UserPanel />
      {showCreateChannel && space && (
        <CreateChannelModal
          space={space}
          onClose={() => setShowCreateChannel(false)}
          onCreated={(roomId) => {
            setShowCreateChannel(false);
            setSelectedRoomId(roomId);
          }}
        />
      )}
      {showSpaceSettings && space && (
        <SpaceSettingsModal space={space} onClose={() => setShowSpaceSettings(false)} />
      )}
      {showAddExistingChannel && space && (
        <AddExistingChannelModal
          space={space}
          existingRoomIds={new Set(spaceRooms.map((r) => r.roomId))}
          onClose={() => setShowAddExistingChannel(false)}
        />
      )}
      {showStartDm && (
        <StartDmModal
          onClose={() => setShowStartDm(false)}
          onCreated={(roomId) => {
            setShowStartDm(false);
            setSelectedRoomId(roomId);
          }}
        />
      )}
    </aside>
  );
}

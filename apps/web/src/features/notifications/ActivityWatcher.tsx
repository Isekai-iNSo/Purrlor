import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { ClientEvent, RoomEvent, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { activityAtom } from '../../app/state/feed';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import {
  ACTIVITY_SEEN_ACCOUNT_DATA,
  fetchActivity,
  isActivityEventType,
  ownFeedRoomIds,
  readActivitySeen,
} from '../../matrix/activity';
import { MENTION_INBOX_EVENT } from '../../matrix/mentionInbox';

/** New activity arrives in bursts (several likes at once); one re-read covers the burst. */
const RELOAD_DELAY_MS = 1500;
/** A slow safety net for anything the live listeners can't see (a room joined elsewhere, say). */
const RELOAD_EVERY_MS = 5 * 60_000;

/**
 * Keeps Activity (matrix/activity.ts) current for the global feed's tab and the unread dot on
 * the rail: read once at start, then again whenever someone else's like, comment, repost or follow
 * lands in one of your feed rooms, or the mention inbox gains an entry.
 *
 * Headless: mounted once in AppShell, renders nothing, runs for the app's lifetime.
 */
export function ActivityWatcher() {
  const mx = useMatrixClient();
  const setActivity = useSetAtom(activityAtom);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      const items = await fetchActivity(mx).catch(() => undefined);
      if (!cancelled && items) setActivity((prev) => ({ ...prev, items, loaded: true }));
    };
    const reloadSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), RELOAD_DELAY_MS);
    };

    setActivity((prev) => ({ ...prev, seenTs: readActivitySeen(mx) }));
    void load();

    const onTimeline = (event: MatrixEvent, room: Room | undefined, toStart: boolean | undefined) => {
      if (toStart || !room || event.getSender() === mx.getUserId()) return;
      // A redaction can undo a like or a comment, so it's a change too.
      const relevant = isActivityEventType(event.getType()) || event.getType() === 'm.room.redaction';
      if (relevant && ownFeedRoomIds(mx).includes(room.roomId)) reloadSoon();
    };
    const onAccountData = (event: MatrixEvent) => {
      if (event.getType() === MENTION_INBOX_EVENT) reloadSoon();
      if (event.getType() === ACTIVITY_SEEN_ACCOUNT_DATA) setActivity((prev) => ({ ...prev, seenTs: readActivitySeen(mx) }));
    };
    const interval = setInterval(() => void load(), RELOAD_EVERY_MS);

    mx.on(RoomEvent.Timeline, onTimeline);
    mx.on(ClientEvent.AccountData, onAccountData);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
      mx.removeListener(RoomEvent.Timeline, onTimeline);
      mx.removeListener(ClientEvent.AccountData, onAccountData);
    };
  }, [mx, setActivity]);

  return null;
}

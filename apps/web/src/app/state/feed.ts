import { atom } from 'jotai';
import type { ActivityItem } from '../../matrix/activity';

/**
 * What the global feed's search box holds — `#tag` or words (matrix/hashtags.ts). Set from
 * anywhere a hashtag is tapped, which also opens the global feed; empty means no search.
 */
export const feedSearchAtom = atom('');

/** Bumped by the N shortcut: the composer on screen takes focus (PostComposer). */
export const composerFocusAtom = atom(0);

/** Bumped after pinning or unpinning, so a profile re-reads which post is pinned. */
export const profileRevisionAtom = atom(0);

/** Activity (matrix/activity.ts), kept current by ActivityWatcher for the tab and the rail's dot. */
export type ActivityState = { items: ActivityItem[]; loaded: boolean; seenTs: number };
export const activityAtom = atom<ActivityState>({ items: [], loaded: false, seenTs: 0 });

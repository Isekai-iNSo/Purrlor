import { useSetAtom } from 'jotai';
import { feedSearchAtom } from '../../app/state/feed';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom } from '../../app/state/selection';

/** Opens a hashtag's timeline: the global feed, searching for that tag. */
export function useOpenHashtag(): (tag: string) => void {
  const setSearch = useSetAtom(feedSearchAtom);
  const setGlobalFeedOpen = useSetAtom(globalFeedOpenAtom);
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setOpenPost = useSetAtom(openPostAtom);
  return (tag: string) => {
    setSearch(`#${tag}`);
    setOpenPost(null);
    setProfileUserId(null);
    setGlobalFeedOpen(true);
  };
}

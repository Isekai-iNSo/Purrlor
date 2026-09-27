import { useEffect } from 'react';
import { atom, useAtom, useSetAtom } from 'jotai';
import { profileRevisionAtom } from '../../app/state/feed';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { getExtendedProfile, setPinnedPost, type PinnedPostRef } from '../../matrix/extendedProfile';

/** Your own pinned post: `undefined` until read, `null` for none. Read once per session and kept
 *  here, since every one of your post cards asks whether it's the pinned one. */
const myPinnedAtom = atom<PinnedPostRef | null | undefined>(undefined);
let loading: Promise<void> | undefined;

export function useMyPinnedPost(): { pinned: PinnedPostRef | null | undefined; pin: (post: PinnedPostRef | null) => Promise<void> } {
  const mx = useMatrixClient();
  const [pinned, setPinned] = useAtom(myPinnedAtom);
  const bumpProfile = useSetAtom(profileRevisionAtom);

  useEffect(() => {
    if (pinned !== undefined || loading) return;
    loading = getExtendedProfile(mx, mx.getUserId() ?? '')
      .then((profile) => setPinned(profile.pinnedPost ?? null))
      .finally(() => {
        loading = undefined;
      });
  }, [mx, pinned, setPinned]);

  const pin = async (post: PinnedPostRef | null) => {
    await setPinnedPost(mx, post);
    setPinned(post);
    bumpProfile((n) => n + 1);
  };

  return { pinned, pin };
}

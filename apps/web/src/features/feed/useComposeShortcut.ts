import { useEffect } from 'react';
import { useSetAtom, useStore } from 'jotai';
import { composerFocusAtom, feedSearchAtom } from '../../app/state/feed';
import { globalFeedOpenAtom, openPostAtom, profileUserIdAtom, selectedSpaceViewAtom } from '../../app/state/selection';
import { useMatrixClient } from '../../matrix/MatrixClientContext';

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/**
 * **N** writes a new post, from anywhere: the composer already on screen takes focus, or — in a
 * chat, a post's page, someone else's profile — the global feed opens with its composer focused.
 * Ignored while typing, with a modifier held, or with a dialog open.
 */
export function useComposeShortcut() {
  const mx = useMatrixClient();
  const store = useStore();
  const requestFocus = useSetAtom(composerFocusAtom);

  useEffect(() => {
    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key !== 'n' && evt.key !== 'N') return;
      if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.repeat || isTyping(evt.target)) return;
      if (document.querySelector('[data-nu-role="modal"]')) return;
      evt.preventDefault();

      const profile = store.get(profileUserIdAtom);
      const onOwnProfile = profile === mx.getUserId();
      const onFeed = store.get(globalFeedOpenAtom) || store.get(selectedSpaceViewAtom) === 'feed';
      const composerShowing = !store.get(openPostAtom) && (onOwnProfile || (!profile && onFeed));
      if (!composerShowing) {
        store.set(openPostAtom, null);
        store.set(profileUserIdAtom, null);
        store.set(globalFeedOpenAtom, true);
      }
      // A search hides the global feed's composer; writing a post means leaving it.
      store.set(feedSearchAtom, '');
      requestFocus((n) => n + 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mx, store, requestFocus]);
}

import { useLayoutEffect, useRef } from 'react';

/**
 * For a feed that stays mounted, but hidden, while a post or profile is open over it: remembers
 * how far down it was scrolled and puts it back there when it's shown again. A hidden element
 * reads as scrolled to the top, so the position is only recorded while it's visible.
 */
export function useKeptScroll<T extends HTMLElement>(hidden: boolean) {
  const ref = useRef<T>(null);
  const top = useRef(0);

  useLayoutEffect(() => {
    if (!hidden && ref.current) ref.current.scrollTop = top.current;
  }, [hidden]);

  const onScroll = () => {
    if (!hidden && ref.current) top.current = ref.current.scrollTop;
  };

  return { ref, onScroll };
}

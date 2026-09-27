import { useEffect, useRef } from 'react';

/**
 * Loads more as the reader nears the end of a list: returns a ref for an empty element placed
 * after the list, and calls `onLoadMore` whenever it comes within a screenful of view. The
 * observer is re-made after each load, and a fresh observer reports straight away — so a page that
 * didn't fill the screen loads the next one too, without the reader having to scroll.
 *
 * A hidden list (a feed kept mounted under a post) never intersects, so it never loads.
 */
export function useInfiniteScroll({ hasMore, loading, onLoadMore }: { hasMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadMore);
  loadRef.current = onLoadMore;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadRef.current();
      },
      { rootMargin: '0px 0px 800px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading]);

  return sentinelRef;
}

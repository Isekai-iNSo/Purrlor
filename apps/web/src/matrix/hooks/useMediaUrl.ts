import { useEffect, useState } from 'react';
import { useMatrixClient } from '../MatrixClientContext';
import { needsMediaAuthentication } from '../mediaAuth';

type MediaUrlOptions = {
  width?: number;
  height?: number;
  method?: 'crop' | 'scale';
};

// Same rationale as useAttachmentUrl's cache: the same avatar renders in several places at
// once (server rail, channel list, every message from that sender, member list) and re-renders
// on every revisit/reload — without a cache each of those independently re-fetches. Keyed by
// the fully-resolved HTTP URL (which already encodes size/method) since different requested
// sizes are genuinely different bytes.
const authedMediaUrlCache = new Map<string, Promise<string>>();

// Synchronous record of already-resolved srcs, keyed by the *request* (mxc + size/method) rather
// than the HTTP URL, since the HTTP URL itself is only known after the async auth check. Lets a
// freshly mounted Avatar (e.g. a new message from someone whose avatar is already on screen)
// render the image on its first paint instead of flashing the initial-letter fallback while the
// async resolve re-runs.
const resolvedSrcCache = new WeakMap<ReturnType<typeof useMatrixClient>, Map<string, string>>();

function resolvedKey(mxcUrl: string, width?: number, height?: number, method?: string): string {
  return `${mxcUrl}|${width ?? ''}|${height ?? ''}|${method ?? ''}`;
}

function getResolvedSrc(
  mx: ReturnType<typeof useMatrixClient>,
  mxcUrl: string | null | undefined,
  width?: number,
  height?: number,
  method?: string,
): string | null {
  if (!mxcUrl) return null;
  return resolvedSrcCache.get(mx)?.get(resolvedKey(mxcUrl, width, height, method)) ?? null;
}

function setResolvedSrc(
  mx: ReturnType<typeof useMatrixClient>,
  mxcUrl: string,
  src: string,
  width?: number,
  height?: number,
  method?: string,
): void {
  let perClient = resolvedSrcCache.get(mx);
  if (!perClient) {
    perClient = new Map();
    resolvedSrcCache.set(mx, perClient);
  }
  perClient.set(resolvedKey(mxcUrl, width, height, method), src);
}

async function resolveAuthenticatedMedia(mx: ReturnType<typeof useMatrixClient>, httpUrl: string): Promise<string> {
  const res = await fetch(httpUrl, { headers: { Authorization: `Bearer ${mx.getAccessToken()}` } });
  if (!res.ok) throw new Error(`Media fetch failed: ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Resolves a plain (unencrypted) `mxc://` URL — avatars, mainly — into something usable in
 * `<img src>`. On homeservers that don't require authenticated media, this is just the plain
 * HTTP URL (cheap: browser-cacheable, no extra fetch). On ones that do, a bare <img> tag can't
 * attach the required Authorization header, so this fetches the bytes itself and hands back a
 * cached blob: URL instead. For message attachments, which may additionally be E2EE-encrypted
 * at the file level, see useAttachmentUrl — that's a different problem (always needs a byte
 * fetch to decrypt) from this hook's "cheap path when possible" one.
 */
export function useMediaUrl(mxcUrl: string | null | undefined, options: MediaUrlOptions = {}): string | null {
  const mx = useMatrixClient();
  const { width, height } = options;
  // Only defaults to 'scale' when an actual thumbnail is being requested (width or height
  // given) — matrix-js-sdk's mxcUrlToHttp treats a *truthy* resizeMethod alone as "this is a
  // thumbnail request" regardless of width/height, so a bare `method` default here would wrongly
  // route a no-dimensions request (Avatar.tsx's animated path, EmoteImage.tsx) to `/thumbnail`
  // instead of `/download` — the wrong endpoint for "give me the whole original file".
  const method = options.method ?? (width || height ? 'scale' : undefined);
  const [src, setSrc] = useState<string | null>(() => getResolvedSrc(mx, mxcUrl, width, height, method));

  useEffect(() => {
    if (!mxcUrl) {
      setSrc(null);
      return undefined;
    }

    const known = getResolvedSrc(mx, mxcUrl, width, height, method);
    if (known) {
      setSrc(known);
      return undefined;
    }

    let cancelled = false;

    (async () => {
      const useAuth = await needsMediaAuthentication(mx);
      const httpUrl = mx.mxcUrlToHttp(mxcUrl, width, height, method, undefined, undefined, useAuth);
      if (!httpUrl) {
        if (!cancelled) setSrc(null);
        return;
      }

      if (!useAuth) {
        setResolvedSrc(mx, mxcUrl, httpUrl, width, height, method);
        if (!cancelled) setSrc(httpUrl);
        return;
      }

      let cached = authedMediaUrlCache.get(httpUrl);
      if (!cached) {
        cached = resolveAuthenticatedMedia(mx, httpUrl).catch((err: unknown) => {
          authedMediaUrlCache.delete(httpUrl);
          throw err;
        });
        authedMediaUrlCache.set(httpUrl, cached);
      }

      try {
        const url = await cached;
        setResolvedSrc(mx, mxcUrl, url, width, height, method);
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setSrc(null);
      }
    })();

    return () => {
      cancelled = true;
      // Not revoking — see useAttachmentUrl for the same cached-and-shared-across-mounts tradeoff.
    };
  }, [mx, mxcUrl, width, height, method]);

  return src;
}

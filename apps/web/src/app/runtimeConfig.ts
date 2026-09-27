/**
 * Per-deployment settings read at page load from `/config.json`, which the web container writes
 * at startup from its environment (apps/web/deploy/40-purrlor-config.sh) — so one built image can
 * be pointed at a different deployment without a rebuild, the same property the rest of this
 * bundle keeps (see apps/web/Dockerfile's top comment).
 *
 * Absent (the Vite dev server, or a deployment that sets nothing), every field is undefined and
 * the app behaves exactly as it always has: the login and register screens ask for a homeserver,
 * and voice and push are set up by hand in Space and Account settings.
 */
export type RuntimeConfig = {
  /** When set, the login and register screens use this homeserver and don't offer to change it.
   *  A base URL (`https://matrix.example.com`) or a server name resolved via .well-known. */
  homeserver?: string;
  /** This deployment's LiveKit and token server. A Space on this homeserver with no voice server
   *  of its own is given these the first time an admin opens it (deploymentDefaults.ts), so voice
   *  works without anyone filling in Space Settings. */
  livekitUrl?: string;
  tokenEndpoint?: string;
  /** This deployment's push gateway: what background notifications use until someone picks
   *  another in Account Settings. */
  pushGateway?: string;
};

let config: RuntimeConfig = {};

const FIELDS = ['homeserver', 'livekitUrl', 'tokenEndpoint', 'pushGateway'] as const;

export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (!raw || typeof raw !== 'object') return {};
  const parsed: RuntimeConfig = {};
  for (const field of FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    // Empty means "not set" — an unconfigured container writes every field as "".
    if (typeof value === 'string' && value.trim()) parsed[field] = value.trim();
  }
  return parsed;
}

/** Never throws: a missing or malformed config.json just means "no deployment overrides". The
 *  dev server answers /config.json with index.html (SPA fallback), which lands here as a JSON
 *  parse failure and is treated the same way. */
export async function loadRuntimeConfig(): Promise<void> {
  try {
    const res = await fetch('/config.json', { cache: 'no-store' });
    config = res.ok ? parseRuntimeConfig(await res.json()) : {};
  } catch {
    config = {};
  }
}

export function getRuntimeConfig(): RuntimeConfig {
  return config;
}

/** How a locked homeserver is shown to the user — the host, not the full URL. */
export function homeserverDisplayName(homeserver: string): string {
  try {
    return /^https?:\/\//i.test(homeserver) ? new URL(homeserver).host : homeserver;
  } catch {
    return homeserver;
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeConfig, homeserverDisplayName, loadRuntimeConfig, parseRuntimeConfig } from './runtimeConfig';

describe('parseRuntimeConfig', () => {
  it('keeps a non-empty homeserver, trimmed', () => {
    expect(parseRuntimeConfig({ homeserver: ' https://matrix.example.com ' })).toEqual({
      homeserver: 'https://matrix.example.com',
    });
  });

  it('treats an empty homeserver as unset, so an unconfigured container changes nothing', () => {
    expect(parseRuntimeConfig({ homeserver: '' })).toEqual({});
  });

  it('reads the voice and push defaults alongside the homeserver, skipping empty ones', () => {
    expect(
      parseRuntimeConfig({
        homeserver: 'https://matrix.example.com',
        livekitUrl: 'wss://livekit.example.com',
        tokenEndpoint: 'https://app.example.com/api/livekit/token',
        pushGateway: '',
      })
    ).toEqual({
      homeserver: 'https://matrix.example.com',
      livekitUrl: 'wss://livekit.example.com',
      tokenEndpoint: 'https://app.example.com/api/livekit/token',
    });
  });

  it('ignores anything that is not an object with a string homeserver', () => {
    expect(parseRuntimeConfig(null)).toEqual({});
    expect(parseRuntimeConfig('https://x')).toEqual({});
    expect(parseRuntimeConfig({ homeserver: 42 })).toEqual({});
  });
});

describe('loadRuntimeConfig', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to no overrides when config.json is the SPA fallback page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 }))
    );
    await loadRuntimeConfig();
    expect(getRuntimeConfig()).toEqual({});
  });

  it('falls back to no overrides when the request fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );
    await loadRuntimeConfig();
    expect(getRuntimeConfig()).toEqual({});
  });

  it('reads the homeserver a deployment configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ homeserver: 'https://matrix.example.com' })))
    );
    await loadRuntimeConfig();
    expect(getRuntimeConfig()).toEqual({ homeserver: 'https://matrix.example.com' });
  });
});

describe('homeserverDisplayName', () => {
  it('shows the host of a base URL and a bare server name as-is', () => {
    expect(homeserverDisplayName('https://matrix.example.com/')).toBe('matrix.example.com');
    expect(homeserverDisplayName('example.com')).toBe('example.com');
  });
});

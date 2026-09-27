import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { adoptDefaultVoiceServer } from './deploymentDefaults';

const runtime = vi.hoisted(() => ({ config: {} as Record<string, string> }));
vi.mock('../app/runtimeConfig', () => ({ getRuntimeConfig: () => runtime.config }));

const BOT = '@purrlor-voice-bot:example.com';
const DEFAULTS = { livekitUrl: 'wss://livekit.example.com', tokenEndpoint: 'https://app.example.com/api/livekit/token' };

type SpaceOptions = { voiceEvent?: Record<string, unknown>; myLevel?: number; creator?: string; botJoined?: boolean };

function makeSpace({ voiceEvent, myLevel = 100, creator = '@me:example.com', botJoined = false }: SpaceOptions = {}) {
  const state: Record<string, { getContent: () => unknown; getSender: () => string } | undefined> = {
    'm.room.power_levels': { getContent: () => ({ users: { '@me:example.com': myLevel }, state_default: 50 }), getSender: () => creator },
    'm.room.create': { getContent: () => ({}), getSender: () => creator },
    ...(voiceEvent && { 'xyz.nekous.voice_server': { getContent: () => voiceEvent, getSender: () => creator } }),
  };
  return {
    roomId: '!space',
    currentState: {
      getStateEvents: (type: string, key?: string) => (key === undefined ? [] : state[type]),
    },
    getMember: (userId: string) => (userId === BOT && botJoined ? { membership: 'join' } : null),
    getMyMembership: () => 'join',
  } as unknown as Room;
}

const mx = {
  getUserId: () => '@me:example.com',
  getRoom: () => null,
  sendStateEvent: vi.fn(async () => ({})),
  invite: vi.fn(async () => ({})),
} as unknown as MatrixClient & { sendStateEvent: ReturnType<typeof vi.fn>; invite: ReturnType<typeof vi.fn> };

beforeEach(() => {
  runtime.config = { ...DEFAULTS };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ botUserId: BOT }), { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('adoptDefaultVoiceServer', () => {
  it('gives an unconfigured Space the deployment’s voice server and invites the bot', async () => {
    expect(await adoptDefaultVoiceServer(mx, makeSpace())).toBe(true);
    expect(mx.sendStateEvent).toHaveBeenCalledWith(
      '!space',
      'xyz.nekous.voice_server',
      { url: DEFAULTS.livekitUrl, tokenEndpoint: DEFAULTS.tokenEndpoint, botUserId: BOT },
      ''
    );
    expect(fetch).toHaveBeenCalledWith('https://app.example.com/api/livekit/config');
  });

  it('does nothing without deployment defaults', async () => {
    runtime.config = {};
    expect(await adoptDefaultVoiceServer(mx, makeSpace())).toBe(false);
    expect(mx.sendStateEvent).not.toHaveBeenCalled();
  });

  it('leaves a Space alone that already chose — including turning voice off', async () => {
    expect(await adoptDefaultVoiceServer(mx, makeSpace({ voiceEvent: {} }))).toBe(false);
    expect(await adoptDefaultVoiceServer(mx, makeSpace({ voiceEvent: { url: 'wss://other', tokenEndpoint: 'https://other/t' } }))).toBe(false);
    expect(mx.sendStateEvent).not.toHaveBeenCalled();
  });

  it('needs the power to change the Space’s settings', async () => {
    expect(await adoptDefaultVoiceServer(mx, makeSpace({ myLevel: 0 }))).toBe(false);
    expect(mx.sendStateEvent).not.toHaveBeenCalled();
  });

  it('skips a Space made on another homeserver, which this token server would never serve', async () => {
    expect(await adoptDefaultVoiceServer(mx, makeSpace({ creator: '@someone:elsewhere.org' }))).toBe(false);
    expect(mx.sendStateEvent).not.toHaveBeenCalled();
  });
});

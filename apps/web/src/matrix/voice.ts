import { EventType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';

/**
 * Per-Space LiveKit server discovery — one LiveKit deployment (and its token server) per Space
 * (Discord's "server"), shared by every voice channel inside it. Custom state event, no
 * Matrix-native equivalent for this (cinny-voice used a client-local "voice server address
 * book" instead — this replaces that with something anyone in the Space can discover
 * automatically). Same read/write/hook shape as every other custom marker in this codebase
 * (emotes, pins, channel type).
 */
export const VOICE_SERVER_EVENT = 'xyz.nekous.voice_server';

export type VoiceServerConfig = {
  url: string;
  tokenEndpoint: string;
  /**
   * The token server's membership-checking bot (`GET /api/livekit/config`). Optional because a
   * Space configured before this field existed simply won't have it — everything still works,
   * it just falls back to "an admin has to invite the bot by hand" instead of the client doing
   * it. Stored here rather than fetched per-call so every member can see and act on it without
   * an extra round trip, the same way the URLs themselves are.
   */
  botUserId?: string;
};
type VoiceServerContent = { url?: string; tokenEndpoint?: string; botUserId?: string };

/** The Space's own config, with no `m.space.parent` fallback — what the settings form edits. */
export function readOwnVoiceServerConfig(space: Room): VoiceServerConfig | undefined {
  const content = space.currentState.getStateEvents(VOICE_SERVER_EVENT, '')?.getContent<VoiceServerContent>();
  if (!content?.url || !content.tokenEndpoint) return undefined;
  return { url: content.url, tokenEndpoint: content.tokenEndpoint, botUserId: content.botUserId };
}

/**
 * Reads the Space's own voice server config, falling back up `m.space.parent` for nested
 * sub-spaces (a sub-space with no voice server configured inherits its parent's).
 */
export function readVoiceServerConfig(mx: MatrixClient, space: Room, depth = 0): VoiceServerConfig | undefined {
  const own = readOwnVoiceServerConfig(space);
  if (own) return own;
  if (depth > 5) return undefined; // guard against a pathological parent cycle

  const parentEvents = space.currentState.getStateEvents(EventType.SpaceParent) as MatrixEvent[];
  const parentId = parentEvents[0]?.getStateKey();
  if (!parentId) return undefined;

  const parent = mx.getRoom(parentId);
  if (!parent) return undefined;

  return readVoiceServerConfig(mx, parent, depth + 1);
}

export async function setVoiceServerConfig(mx: MatrixClient, space: Room, config: VoiceServerConfig): Promise<void> {
  await mx.sendStateEvent(space.roomId, VOICE_SERVER_EVENT as any, config as any, '');
}

/**
 * Removes this Space's own voice server config. Written as an empty content rather than
 * redacted: Matrix has no "delete a state event", and `readOwnVoiceServerConfig` already treats
 * a content without both URLs as "not configured" — so a sub-space cleared this way correctly
 * goes back to inheriting its parent's rather than being left with a half-set event.
 */
export async function clearVoiceServerConfig(mx: MatrixClient, space: Room): Promise<void> {
  await mx.sendStateEvent(space.roomId, VOICE_SERVER_EVENT as any, {} as any, '');
}

/**
 * Finds the Space a room belongs to via its own `m.space.parent` state event — every channel
 * (voice or text) is created with one (see CreateChannelModal/roomCreation.ts), so this only
 * returns undefined for rooms that aren't a Space's child (DMs, group chats).
 */
export function getParentSpace(mx: MatrixClient, room: Room): Room | undefined {
  const parentEvents = room.currentState.getStateEvents(EventType.SpaceParent) as MatrixEvent[];
  const parentId = parentEvents[0]?.getStateKey();
  if (!parentId) return undefined;
  return mx.getRoom(parentId) ?? undefined;
}

/**
 * Derives a LiveKit room name from a Matrix room ID — deterministic and reversible (base64url,
 * not a hash), so a LiveKit-side room name can be mapped straight back to the Matrix room it
 * belongs to for debugging/webhooks without a lookup table. Must stay byte-identical to the
 * token server's own copy of this function (documented in docs/voice-architecture.md).
 */
export function livekitRoomName(matrixRoomId: string): string {
  const base64 = btoa(matrixRoomId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `matrix-${base64}`;
}

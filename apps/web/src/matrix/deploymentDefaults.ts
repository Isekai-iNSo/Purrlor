import type { MatrixClient, Room } from 'matrix-js-sdk';
import { getRuntimeConfig } from '../app/runtimeConfig';
import { canSendStateEvent } from './permissions';
import { roomOriginServer } from './roomOrigin';
import { readVoiceServerConfig, setVoiceServerConfig, VOICE_SERVER_EVENT } from './voice';
import { ensureVoiceBotInvited, fetchVoiceBotUserId, isRoomOnBotHomeserver } from './voiceBot';

/**
 * Turns voice on in a Space with this deployment's own LiveKit server (runtimeConfig.ts), exactly
 * as an admin saving Space Settings would — the state event, then the voice bot invited into the
 * Space — so a fresh install has working voice channels without anyone knowing the URLs.
 *
 * Only when all of these hold, and otherwise does nothing:
 * - the deployment names a LiveKit server and token endpoint;
 * - the Space has no voice server event at all — not even an empty one, which is an admin having
 *   turned voice *off* on purpose — and doesn't inherit one from a parent Space;
 * - you're allowed to set it (the same power the settings form needs);
 * - the Space was created on the voice bot's homeserver, the only rooms the token server serves
 *   (services/token-server/src/tenancy.ts) — a Space from another server would get a voice server
 *   that could never answer for it.
 *
 * Resolves to whether it turned voice on.
 */
export async function adoptDefaultVoiceServer(mx: MatrixClient, space: Room): Promise<boolean> {
  const { livekitUrl, tokenEndpoint } = getRuntimeConfig();
  if (!livekitUrl || !tokenEndpoint) return false;
  if (space.currentState.getStateEvents(VOICE_SERVER_EVENT, '')) return false;
  if (readVoiceServerConfig(mx, space)) return false;
  if (!canSendStateEvent(space, mx.getUserId() ?? '', VOICE_SERVER_EVENT)) return false;

  const botUserId = await fetchVoiceBotUserId(tokenEndpoint);
  if (!botUserId || !isRoomOnBotHomeserver(roomOriginServer(space), botUserId)) return false;

  const config = { url: livekitUrl, tokenEndpoint, botUserId };
  await setVoiceServerConfig(mx, space, config);
  await ensureVoiceBotInvited(mx, space, config);
  return true;
}

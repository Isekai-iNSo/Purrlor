import { EventType, type MatrixEvent, type Room } from 'matrix-js-sdk';

type PowerLevelsContent = {
  users?: Record<string, number>;
  users_default?: number;
  events?: Record<string, number>;
  state_default?: number;
  redact?: number;
  invite?: number;
  kick?: number;
  ban?: number;
  notifications?: { room?: number };
};

function getPowerLevelsContent(room: Room): PowerLevelsContent {
  return room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent<PowerLevelsContent>() ?? {};
}

/** Room version 12 (and its "hydra" preview) gives creators unlimited power without listing them
 *  in the power levels — Continuwuity's default version. */
function creatorsArePrivileged(roomVersion: unknown): boolean {
  return typeof roomVersion === 'string' && (roomVersion === '12' || roomVersion.startsWith('org.matrix.hydra'));
}

/** A room's privileged creators: the creator and any additional creators, on room version 12 and
 *  later. Empty on older versions, where a creator is just whatever the power levels say. */
export function privilegedCreators(room: Room): string[] {
  const create = room.currentState.getStateEvents(EventType.RoomCreate, '');
  if (!create) return [];
  const content = create.getContent<{ room_version?: unknown; additional_creators?: unknown }>();
  if (!creatorsArePrivileged(content.room_version)) return [];
  const extra = Array.isArray(content.additional_creators)
    ? content.additional_creators.filter((id): id is string => typeof id === 'string')
    : [];
  const sender = create.getSender();
  return [...(sender ? [sender] : []), ...extra];
}

/** Whoever can change everything in the room: power level 100, or a privileged creator. */
export function roomAdmins(room: Room): string[] {
  const listed = Object.entries(getPowerLevelsContent(room).users ?? {})
    .filter(([, level]) => typeof level === 'number' && level >= 100)
    .map(([userId]) => userId);
  return [...new Set([...privilegedCreators(room), ...listed])];
}

/**
 * A user's power level in a room. On room version 12 a privileged creator isn't listed in the
 * power levels at all — the spec forbids it — yet outranks everyone, so reading only `users`
 * scored the person who made a Space as 0 and hid every admin control from them. Continuwuity
 * creates rooms on version 12 by default. (The SDK's own RoomMember.powerLevel already counts
 * creators the same way: Infinity.)
 */
function getUserPowerLevel(room: Room, content: PowerLevelsContent, userId: string): number {
  if (privilegedCreators(room).includes(userId)) return Infinity;
  return content.users?.[userId] ?? content.users_default ?? 0;
}

/**
 * Reads `m.room.power_levels` and checks whether a user is allowed to send a given state event
 * type in this room — the same mechanism Matrix uses to gate renaming, changing the topic/
 * avatar, and so on. Falls back to the spec defaults (`state_default: 50`, `users_default: 0`)
 * when a room hasn't customized them.
 */
export function canSendStateEvent(room: Room, userId: string, eventType: string): boolean {
  const content = getPowerLevelsContent(room);
  const requiredLevel = content.events?.[eventType] ?? content.state_default ?? 50;
  return getUserPowerLevel(room, content, userId) >= requiredLevel;
}

/**
 * Per the spec, redaction is always allowed on your own events regardless of power level (the
 * same rule every Matrix client follows for "delete my own message") — otherwise it takes the
 * room's dedicated `redact` power level (default 50), separate from `state_default`.
 */
export function canRedactEvent(room: Room, userId: string, event: MatrixEvent): boolean {
  if (event.getSender() === userId) return true;
  const content = getPowerLevelsContent(room);
  return getUserPowerLevel(room, content, userId) >= (content.redact ?? 50);
}

/** Matrix's own default for `invite` is 0 — any joined member can invite unless a room has
 *  deliberately locked it down, unlike kick/ban which default to moderator level (50). */
export function canInviteToRoom(room: Room, userId: string): boolean {
  const content = getPowerLevelsContent(room);
  return getUserPowerLevel(room, content, userId) >= (content.invite ?? 0);
}

export function canKickFromRoom(room: Room, userId: string, targetPowerLevel: number): boolean {
  const content = getPowerLevelsContent(room);
  const myLevel = getUserPowerLevel(room, content, userId);
  return myLevel >= (content.kick ?? 50) && myLevel > targetPowerLevel;
}

export function canBanFromRoom(room: Room, userId: string, targetPowerLevel: number): boolean {
  const content = getPowerLevelsContent(room);
  const myLevel = getUserPowerLevel(room, content, userId);
  return myLevel >= (content.ban ?? 50) && myLevel > targetPowerLevel;
}

/** Whether this user could ban *someone* here, without a specific target to compare against —
 *  used to decide whether the banned-users list (with its Unban action) is worth showing at all. */
export function canManageBans(room: Room, userId: string): boolean {
  const content = getPowerLevelsContent(room);
  return getUserPowerLevel(room, content, userId) >= (content.ban ?? 50);
}

/** The `@room` mass-mention (Discord's `@everyone`) — spec default requires power level 50,
 *  same as kick/ban, not the much lower `state_default`/`users_default` a plain message needs. */
export function canMentionRoom(room: Room, userId: string): boolean {
  const content = getPowerLevelsContent(room);
  return getUserPowerLevel(room, content, userId) >= (content.notifications?.room ?? 50);
}

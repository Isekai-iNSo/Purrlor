import { describe, expect, it } from 'vitest';
import {
  canBanFromRoom,
  canInviteToRoom,
  canKickFromRoom,
  canManageBans,
  canMentionRoom,
  canRedactEvent,
  canSendStateEvent,
} from './permissions';

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

function fakeRoom(content: PowerLevelsContent) {
  return {
    currentState: {
      getStateEvents: () => ({ getContent: () => content }),
    },
  } as unknown as Parameters<typeof canSendStateEvent>[0];
}

function fakeRoomWithNoPowerLevels() {
  return {
    currentState: {
      getStateEvents: () => undefined,
    },
  } as unknown as Parameters<typeof canSendStateEvent>[0];
}

function fakeEvent(sender: string) {
  return { getSender: () => sender } as unknown as Parameters<typeof canRedactEvent>[2];
}

describe('canSendStateEvent', () => {
  it('falls back to spec defaults (state_default 50, users_default 0) with no customization', () => {
    const room = fakeRoomWithNoPowerLevels();
    expect(canSendStateEvent(room, '@mod:example.org', 'm.room.name')).toBe(false);
  });

  it('allows a user whose power level meets the per-event-type requirement', () => {
    const room = fakeRoom({ users: { '@mod:example.org': 50 }, events: { 'm.room.name': 50 } });
    expect(canSendStateEvent(room, '@mod:example.org', 'm.room.name')).toBe(true);
  });

  it('denies a user below the requirement', () => {
    const room = fakeRoom({ users: { '@member:example.org': 0 }, events: { 'm.room.name': 50 } });
    expect(canSendStateEvent(room, '@member:example.org', 'm.room.name')).toBe(false);
  });

  it('falls back to state_default when the event type has no explicit override', () => {
    const room = fakeRoom({ users: { '@admin:example.org': 100 }, state_default: 50 });
    expect(canSendStateEvent(room, '@admin:example.org', 'm.room.topic')).toBe(true);
  });
});

describe('canRedactEvent', () => {
  it('always allows redacting your own event, regardless of power level', () => {
    const room = fakeRoom({ users_default: 0, redact: 50 });
    expect(canRedactEvent(room, '@me:example.org', fakeEvent('@me:example.org'))).toBe(true);
  });

  it("requires the room's redact power level to remove someone else's event", () => {
    const room = fakeRoom({ users: { '@mod:example.org': 50 }, redact: 50 });
    expect(canRedactEvent(room, '@mod:example.org', fakeEvent('@someone:example.org'))).toBe(true);
    expect(canRedactEvent(room, '@member:example.org', fakeEvent('@someone:example.org'))).toBe(false);
  });
});

describe('canInviteToRoom', () => {
  it('defaults to allowing any joined member (invite power level 0)', () => {
    const room = fakeRoomWithNoPowerLevels();
    expect(canInviteToRoom(room, '@anyone:example.org')).toBe(true);
  });

  it('respects a room that has locked invites down to a higher level', () => {
    const room = fakeRoom({ invite: 50, users_default: 0 });
    expect(canInviteToRoom(room, '@member:example.org')).toBe(false);
  });
});

describe('canKickFromRoom / canBanFromRoom', () => {
  it('requires both the power-level threshold and being strictly above the target', () => {
    const room = fakeRoom({ users: { '@mod:example.org': 50 }, kick: 50, ban: 50 });
    // Meets the threshold, and target (0) is below.
    expect(canKickFromRoom(room, '@mod:example.org', 0)).toBe(true);
    expect(canBanFromRoom(room, '@mod:example.org', 0)).toBe(true);
    // Meets the threshold, but the target is at the same level — Matrix forbids this.
    expect(canKickFromRoom(room, '@mod:example.org', 50)).toBe(false);
    expect(canBanFromRoom(room, '@mod:example.org', 50)).toBe(false);
  });

  it('denies a user below the kick/ban power level entirely', () => {
    const room = fakeRoom({ users_default: 0, kick: 50, ban: 50 });
    expect(canKickFromRoom(room, '@member:example.org', 0)).toBe(false);
    expect(canBanFromRoom(room, '@member:example.org', 0)).toBe(false);
  });
});

describe('canManageBans', () => {
  it('reflects whether the user meets the ban threshold, with no target to compare against', () => {
    const room = fakeRoom({ users: { '@mod:example.org': 50 }, ban: 50 });
    expect(canManageBans(room, '@mod:example.org')).toBe(true);
    expect(canManageBans(room, '@member:example.org')).toBe(false);
  });
});

describe('canMentionRoom', () => {
  it('defaults to requiring power level 50, same as kick/ban, with no customization', () => {
    const room = fakeRoomWithNoPowerLevels();
    expect(canMentionRoom(room, '@member:example.org')).toBe(false);
  });

  it('respects an explicit notifications.room override', () => {
    const room = fakeRoom({ users: { '@member:example.org': 10 }, notifications: { room: 10 } });
    expect(canMentionRoom(room, '@member:example.org')).toBe(true);
  });

  it('denies a user below the required level', () => {
    const room = fakeRoom({ users: { '@member:example.org': 0 }, notifications: { room: 50 } });
    expect(canMentionRoom(room, '@member:example.org')).toBe(false);
  });
});

describe('room version 12 creators', () => {
  // A v12 room: the creator is deliberately absent from power_levels.users, as the spec requires.
  function v12Room(content: PowerLevelsContent, roomVersion = '12', additionalCreators: string[] = []) {
    return {
      currentState: {
        getStateEvents: (type: string) =>
          type === 'm.room.create'
            ? {
                getContent: () => ({ room_version: roomVersion, additional_creators: additionalCreators }),
                getSender: () => '@creator:x',
              }
            : { getContent: () => content },
      },
    } as unknown as Parameters<typeof canSendStateEvent>[0];
  }
  const levels = { users: { '@mod:x': 50 }, state_default: 50, kick: 50, ban: 50 };

  it('gives the creator full control though they are not listed in the power levels', () => {
    const room = v12Room(levels);
    expect(canSendStateEvent(room, '@creator:x', 'm.room.name')).toBe(true);
    expect(canKickFromRoom(room, '@creator:x', 50)).toBe(true);
    expect(canBanFromRoom(room, '@creator:x', 100)).toBe(true);
    expect(canManageBans(room, '@creator:x')).toBe(true);
    expect(canMentionRoom(room, '@creator:x')).toBe(true);
  });

  it('counts additional creators too, and nobody else', () => {
    const room = v12Room(levels, '12', ['@co:x']);
    expect(canSendStateEvent(room, '@co:x', 'm.room.name')).toBe(true);
    expect(canSendStateEvent(room, '@member:x', 'm.room.name')).toBe(false);
    expect(canKickFromRoom(room, '@mod:x', 0)).toBe(true);
    expect(canKickFromRoom(room, '@mod:x', 50)).toBe(false);
  });

  it('leaves older room versions to the power levels alone', () => {
    expect(canSendStateEvent(v12Room(levels, '10'), '@creator:x', 'm.room.name')).toBe(false);
  });
});

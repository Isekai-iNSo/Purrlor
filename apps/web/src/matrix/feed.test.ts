import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventType, MatrixEvent, type MatrixClient, type Room } from 'matrix-js-sdk';
import {
  POST_EVENT_TYPE,
  applyPostEdits,
  buildPostContent,
  deletePrivatePost,
  editPost,
  editTargetOf,
  ensureFeedRoom,
  isPostEvent,
  listSpaceFeeds,
  makePostPrivate,
  publishFeedPointer,
  publishPrivatePost,
  readFeedRoomId,
  readPost,
  readPrivatePosts,
  savePrivatePost,
} from './feed';

const ME = '@me:example.org';
const OTHER = '@lin:example.org';
const SPACE_ID = '!space:example.org';
const MY_FEED = '!my-feed:example.org';

type MemberSpec = { userId: string; membership?: string; content?: Record<string, unknown> };

function fakeSpace(members: MemberSpec[]): Room {
  const events = members.map((member) => ({
    getStateKey: () => member.userId,
    getContent: () => ({ membership: member.membership ?? 'join', ...member.content }),
  }));
  return {
    roomId: SPACE_ID,
    name: 'Purrlor',
    loadMembersIfNeeded: async () => undefined,
    currentState: {
      getStateEvents: (type: string, stateKey?: string) => {
        if (type !== EventType.RoomMember) return stateKey === undefined ? [] : null;
        if (stateKey === undefined) return events;
        return events.find((event) => event.getStateKey() === stateKey) ?? null;
      },
    },
  } as unknown as Room;
}

function fakeEvent({
  type = POST_EVENT_TYPE,
  content = { body: 'hello hub' },
  redacted = false,
  id = '$post1',
}: { type?: string; content?: Record<string, unknown>; redacted?: boolean; id?: string } = {}): MatrixEvent {
  return {
    getType: () => type,
    getContent: () => content,
    getWireContent: () => content,
    isRedacted: () => redacted,
    getId: () => id,
  } as unknown as MatrixEvent;
}

function fakeClient({
  joinedRooms = [] as string[],
  historyVisibility = {} as Record<string, string>,
  /** Your member event in the Space as the server has it; unset, the lookup fails. */
  serverMember = undefined as Record<string, unknown> | undefined,
  profile = {} as Record<string, unknown>,
} = {}) {
  const accountData = new Map<string, Record<string, unknown>>();
  const createRoom = vi.fn().mockResolvedValue({ room_id: MY_FEED });
  const sendStateEvent = vi.fn().mockResolvedValue({});
  const sendEvent = vi.fn().mockResolvedValue({});
  const redactEvent = vi.fn().mockResolvedValue({});
  // By default a room you're not in can't be joined back into.
  const joinRoom = vi.fn().mockRejectedValue(Object.assign(new Error('M_FORBIDDEN'), { httpStatus: 403 }));
  const setAccountData = vi.fn(async (type: string, content: Record<string, unknown>) => {
    accountData.set(type, content);
  });

  const mx = {
    getUserId: () => ME,
    getRoom: (roomId: string) =>
      joinedRooms.includes(roomId)
        ? ({
            roomId,
            getMyMembership: () => 'join',
            currentState: {
              getStateEvents: (type: string) =>
                type === EventType.RoomHistoryVisibility && historyVisibility[roomId]
                  ? { getContent: () => ({ history_visibility: historyVisibility[roomId] }) }
                  : null,
            },
          } as unknown as Room)
        : undefined,
    getAccountData: (type: string) => {
      const content = accountData.get(type);
      return content ? { getContent: () => content } : undefined;
    },
    setAccountData,
    getStateEvent: vi.fn(async () => {
      if (!serverMember) throw Object.assign(new Error('M_NOT_FOUND'), { httpStatus: 404 });
      return serverMember;
    }),
    getProfileInfo: vi.fn(async () => profile),
    createRoom,
    sendStateEvent,
    sendEvent,
    redactEvent,
    joinRoom,
  } as unknown as MatrixClient;

  return { mx, accountData, createRoom, sendStateEvent, sendEvent, redactEvent, setAccountData, joinRoom };
}

describe('post events', () => {
  it('accepts a post and reads its message-shaped content', () => {
    const event = fakeEvent({ content: { body: 'hi', format: 'org.matrix.custom.html', formatted_body: '<b>hi</b>' } });
    expect(isPostEvent(event)).toBe(true);
    expect(readPost(event)).toEqual({ body: 'hi', format: 'org.matrix.custom.html', formatted_body: '<b>hi</b>' });
  });

  it('rejects an ordinary chat message, so a feed room never renders one as a post', () => {
    expect(readPost(fakeEvent({ type: 'm.room.message' }))).toBeUndefined();
  });

  it('rejects a redacted post rather than rendering an empty card', () => {
    expect(readPost(fakeEvent({ redacted: true }))).toBeUndefined();
  });

  it('rejects a post with no body at all', () => {
    expect(readPost(fakeEvent({ content: {} }))).toBeUndefined();
  });

  it('omits the format fields entirely when there is no formatting to send', () => {
    expect(buildPostContent('plain')).toEqual({ body: 'plain' });
  });
});

describe('finding feeds', () => {
  it('reads a member’s feed room off their own member event in the space', () => {
    const space = fakeSpace([{ userId: OTHER, content: { 'xyz.nekous.feed_room': '!lin-feed:example.org' } }]);
    expect(readFeedRoomId(space, OTHER)).toBe('!lin-feed:example.org');
  });

  it('returns undefined for a member who has never posted', () => {
    expect(readFeedRoomId(fakeSpace([{ userId: OTHER }]), OTHER)).toBeUndefined();
  });

  it('lists every joined member with a feed', () => {
    const space = fakeSpace([
      { userId: ME, content: { 'xyz.nekous.feed_room': MY_FEED } },
      { userId: OTHER, content: { 'xyz.nekous.feed_room': '!lin-feed:example.org' } },
      { userId: '@quiet:example.org' },
    ]);
    expect(listSpaceFeeds(space)).toEqual([
      { userId: ME, roomId: MY_FEED },
      { userId: OTHER, roomId: '!lin-feed:example.org' },
    ]);
  });

  it('drops a member who left, so their timeline leaves the hub with them', () => {
    const space = fakeSpace([
      { userId: OTHER, membership: 'leave', content: { 'xyz.nekous.feed_room': '!lin-feed:example.org' } },
    ]);
    expect(listSpaceFeeds(space)).toEqual([]);
  });
});

describe('ensureFeedRoom', () => {
  it('creates a members-only room restricted to the space, and records it both places', async () => {
    const { mx, createRoom, sendStateEvent, accountData } = fakeClient();
    const space = fakeSpace([{ userId: ME }]);

    await expect(ensureFeedRoom(mx, space, 'Me')).resolves.toBe(MY_FEED);

    const opts = createRoom.mock.calls[0][0];
    const joinRule = opts.initial_state.find((e: any) => e.type === EventType.RoomJoinRules).content;
    expect(joinRule.join_rule).toBe('restricted');
    expect(joinRule.allow).toEqual([{ type: 'm.room_membership', room_id: SPACE_ID }]);
    // Not told the space is public, so its posts are for its members only.
    expect(
      opts.initial_state.find((e: any) => e.type === EventType.RoomHistoryVisibility).content
    ).toEqual({ history_visibility: 'shared' });
    // Only the owner posts; everyone else keeps the default level so they can still react.
    expect(opts.power_level_content_override).toEqual({ events: { [POST_EVENT_TYPE]: 100 } });

    expect(accountData.get('xyz.nekous.feed_rooms')).toEqual({ [SPACE_ID]: MY_FEED });
    expect(sendStateEvent).toHaveBeenCalledWith(
      SPACE_ID,
      EventType.RoomMember,
      expect.objectContaining({ 'xyz.nekous.feed_room': MY_FEED }),
      ME
    );
  });

  it('makes a public space’s feed world-readable, so the global feed can show it', async () => {
    const { mx, createRoom } = fakeClient();
    await ensureFeedRoom(mx, fakeSpace([{ userId: ME }]), 'Me', true);
    const opts = createRoom.mock.calls[0][0];
    expect(
      opts.initial_state.find((e: any) => e.type === EventType.RoomHistoryVisibility).content
    ).toEqual({ history_visibility: 'world_readable' });
  });

  it('closes an existing world-readable feed room once its space is private', async () => {
    const { mx, sendStateEvent, accountData } = fakeClient({
      joinedRooms: [MY_FEED],
      historyVisibility: { [MY_FEED]: 'world_readable' },
    });
    accountData.set('xyz.nekous.feed_rooms', { [SPACE_ID]: MY_FEED });

    await ensureFeedRoom(mx, fakeSpace([{ userId: ME, content: { 'xyz.nekous.feed_room': MY_FEED } }]), 'Me', false);
    expect(sendStateEvent).toHaveBeenCalledWith(MY_FEED, EventType.RoomHistoryVisibility, { history_visibility: 'shared' }, '');
  });

  it('leaves a feed room alone when its visibility already matches', async () => {
    const { mx, sendStateEvent, accountData } = fakeClient({
      joinedRooms: [MY_FEED],
      historyVisibility: { [MY_FEED]: 'shared' },
    });
    accountData.set('xyz.nekous.feed_rooms', { [SPACE_ID]: MY_FEED });

    await ensureFeedRoom(
      mx,
      fakeSpace([{ userId: ME, content: { displayname: 'Me', 'xyz.nekous.feed_room': MY_FEED } }]),
      'Me',
      false
    );
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('reuses the existing feed room instead of making a second one', async () => {
    const { mx, createRoom, accountData } = fakeClient({ joinedRooms: [MY_FEED] });
    accountData.set('xyz.nekous.feed_rooms', { [SPACE_ID]: MY_FEED });

    await expect(ensureFeedRoom(mx, fakeSpace([{ userId: ME }]), 'Me')).resolves.toBe(MY_FEED);
    expect(createRoom).not.toHaveBeenCalled();
  });

  it('preserves the rest of the member event, so publishing does not wipe a space nickname', async () => {
    const { mx, sendStateEvent } = fakeClient({ joinedRooms: [MY_FEED] });
    const space = fakeSpace([{ userId: ME, content: { displayname: 'Nickname', avatar_url: 'mxc://a/b' } }]);

    await ensureFeedRoom(mx, space, 'Me');

    expect(sendStateEvent).toHaveBeenCalledWith(
      SPACE_ID,
      EventType.RoomMember,
      { membership: 'join', displayname: 'Nickname', avatar_url: 'mxc://a/b', 'xyz.nekous.feed_room': MY_FEED },
      ME
    );
  });

  it('skips the pointer write when it is already correct', async () => {
    const { mx, sendStateEvent } = fakeClient({ joinedRooms: [MY_FEED] });
    const space = fakeSpace([{ userId: ME, content: { displayname: 'Me', 'xyz.nekous.feed_room': MY_FEED } }]);

    await ensureFeedRoom(mx, space, 'Me');
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('puts the pointer back on the server’s copy, so a stale synced name is never written back', async () => {
    // Just renamed: the server rewrote the member event with the new name and without the pointer
    // (what Continuwuity does), and this client hasn't synced that yet.
    const { mx, sendStateEvent } = fakeClient({
      joinedRooms: [MY_FEED],
      serverMember: { membership: 'join', displayname: 'mino' },
    });
    const space = fakeSpace([{ userId: ME, content: { displayname: '@me:example.org' } }]);

    await publishFeedPointer(mx, space, MY_FEED);

    expect(sendStateEvent).toHaveBeenCalledWith(
      SPACE_ID,
      EventType.RoomMember,
      { membership: 'join', displayname: 'mino', 'xyz.nekous.feed_room': MY_FEED },
      ME
    );
  });

  it('gives a nameless member event the global profile’s name, instead of the bare user ID', async () => {
    const { mx, sendStateEvent } = fakeClient({
      joinedRooms: [MY_FEED],
      serverMember: { membership: 'join', 'xyz.nekous.feed_room': MY_FEED },
      profile: { displayname: 'mino', avatar_url: 'mxc://a/b' },
    });

    await publishFeedPointer(mx, fakeSpace([{ userId: ME, content: { 'xyz.nekous.feed_room': MY_FEED } }]), MY_FEED);

    expect(sendStateEvent).toHaveBeenCalledWith(
      SPACE_ID,
      EventType.RoomMember,
      { membership: 'join', displayname: 'mino', avatar_url: 'mxc://a/b', 'xyz.nekous.feed_room': MY_FEED },
      ME
    );
  });

  it('writes nothing when the server already has the pointer and there is no name to add', async () => {
    const { mx, sendStateEvent } = fakeClient({ serverMember: { membership: 'join', 'xyz.nekous.feed_room': MY_FEED } });
    await publishFeedPointer(mx, fakeSpace([{ userId: ME }]), MY_FEED);
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('makes a new room when the recorded one can’t be joined back into', async () => {
    // A stale ID would make every post fail rather than starting a fresh timeline.
    const { mx, createRoom, accountData, joinRoom } = fakeClient({ joinedRooms: [] });
    accountData.set('xyz.nekous.feed_rooms', { [SPACE_ID]: '!gone:example.org' });

    await expect(ensureFeedRoom(mx, fakeSpace([{ userId: ME }]), 'Me')).resolves.toBe(MY_FEED);
    expect(joinRoom).toHaveBeenCalledWith('!gone:example.org', expect.anything());
    expect(createRoom).toHaveBeenCalledTimes(1);
  });

  it('rejoins the recorded room rather than stranding its posts in a new one', async () => {
    const { mx, createRoom, accountData, joinRoom } = fakeClient({ joinedRooms: [] });
    joinRoom.mockResolvedValue({});
    accountData.set('xyz.nekous.feed_rooms', { [SPACE_ID]: '!old:example.org' });

    await expect(ensureFeedRoom(mx, fakeSpace([{ userId: ME }]), 'Me')).resolves.toBe('!old:example.org');
    expect(createRoom).not.toHaveBeenCalled();
    // Joined through the owner's own server, which works even for a room ID with no server part.
    expect(joinRoom).toHaveBeenCalledWith('!old:example.org', { viaServers: expect.arrayContaining(['example.org']) });
  });
});

describe('private posts', () => {
  let now = 1_000;
  beforeEach(() => {
    now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 1_000));
  });

  it('keeps a private post in account data and never sends it to a room', async () => {
    const { mx, sendEvent, accountData } = fakeClient();
    await savePrivatePost(mx, SPACE_ID, 'just for me');

    expect(sendEvent).not.toHaveBeenCalled();
    expect(accountData.get('xyz.nekous.private_posts')).toEqual({
      items: [expect.objectContaining({ spaceId: SPACE_ID, body: 'just for me' })],
    });
  });

  it('adds to the list as the server has it, not a stale synced copy', async () => {
    // Another device saved a post a moment ago; this client hasn't synced it yet.
    const { mx, accountData } = fakeClient();
    const elsewhere = { id: 'post-phone', spaceId: SPACE_ID, body: 'from my phone', createdAt: 1 };
    (mx as unknown as Record<string, unknown>).getAccountDataFromServer = async () => ({ items: [elsewhere] });

    await savePrivatePost(mx, SPACE_ID, 'from this tab');
    expect((accountData.get('xyz.nekous.private_posts') as { items: { body: string }[] }).items.map((p) => p.body)).toEqual([
      'from my phone',
      'from this tab',
    ]);
  });

  it('returns them newest first, scoped to one space', async () => {
    const { mx } = fakeClient();
    await savePrivatePost(mx, SPACE_ID, 'first');
    await savePrivatePost(mx, SPACE_ID, 'second');
    await savePrivatePost(mx, '!elsewhere:example.org', 'other hub');

    expect(readPrivatePosts(mx, SPACE_ID).map((post) => post.body)).toEqual(['second', 'first']);
    expect(readPrivatePosts(mx).map((post) => post.body)).toEqual(['other hub', 'second', 'first']);
  });

  it('deletes one without disturbing the others', async () => {
    const { mx } = fakeClient();
    const doomed = await savePrivatePost(mx, SPACE_ID, 'oops');
    await savePrivatePost(mx, SPACE_ID, 'keep');

    await deletePrivatePost(mx, doomed.id);
    expect(readPrivatePosts(mx, SPACE_ID).map((post) => post.body)).toEqual(['keep']);
  });

  it('unpublishes by redacting first, then keeping the text', async () => {
    // Order matters: if the account-data write fails, the post is still gone from the room,
    // which is what "make this private" was asked to do.
    const { mx, redactEvent } = fakeClient();
    const order: string[] = [];
    (mx as any).redactEvent = vi.fn(async (...args: unknown[]) => {
      order.push('redact');
      return redactEvent(...(args as []));
    });
    (mx as any).setAccountData = vi.fn(async () => {
      order.push('save');
    });

    await makePostPrivate(mx, SPACE_ID, MY_FEED, fakeEvent({ content: { body: 'taking this back' } }));
    expect(order).toEqual(['redact', 'save']);
  });

  it('publishes to the room before dropping the private copy', async () => {
    const { mx, sendEvent } = fakeClient();
    const post = await savePrivatePost(mx, SPACE_ID, 'ready now');

    await publishPrivatePost(mx, MY_FEED, post, buildPostContent('ready now'));

    expect(sendEvent).toHaveBeenCalledWith(MY_FEED, POST_EVENT_TYPE, { body: 'ready now' });
    expect(readPrivatePosts(mx, SPACE_ID)).toEqual([]);
  });
});

describe('post edits', () => {
  const post = (id: string, sender: string, body: string, ts = 1) =>
    new MatrixEvent({ event_id: id, type: POST_EVENT_TYPE, sender, origin_server_ts: ts, room_id: '!f', content: { body } });
  const edit = (id: string, target: string, sender: string, body: string, ts: number) =>
    new MatrixEvent({
      event_id: id,
      type: POST_EVENT_TYPE,
      sender,
      origin_server_ts: ts,
      room_id: '!f',
      content: { body, 'm.new_content': { body }, 'm.relates_to': { rel_type: 'm.replace', event_id: target } },
    });

  it('never shows an edit as a post of its own', () => {
    const e = edit('$e', '$p', ME, 'fixed', 2);
    expect(editTargetOf(e)).toBe('$p');
    expect(isPostEvent(e)).toBe(false);
    expect(readPost(e)).toBeUndefined();
  });

  it('applies the newest edit by the post’s own author', () => {
    const p = post('$p', ME, 'typo');
    const changed = applyPostEdits([p], [edit('$e1', '$p', ME, 'first fix', 2), edit('$e2', '$p', ME, 'second fix', 3)]);
    expect(changed).toBe(true);
    expect(readPost(p)?.body).toBe('second fix');
    // Applying the same edits again changes nothing.
    expect(applyPostEdits([p], [edit('$e1', '$p', ME, 'first fix', 2)])).toBe(false);
  });

  it('ignores an "edit" from anyone else', () => {
    const p = post('$p', ME, 'mine');
    applyPostEdits([p], [edit('$e', '$p', '@mallory:example.org', 'hijacked', 2)]);
    expect(readPost(p)?.body).toBe('mine');
  });

  it('sends an m.replace carrying the whole new content', async () => {
    const { mx, sendEvent } = fakeClient();
    await editPost(mx, MY_FEED, '$p', buildPostContent('new words'));
    const [roomId, type, content] = sendEvent.mock.calls[0];
    expect(roomId).toBe(MY_FEED);
    expect(type).toBe(POST_EVENT_TYPE);
    expect(content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$p' });
    expect(content['m.new_content']).toEqual({ body: 'new words' });
  });
});

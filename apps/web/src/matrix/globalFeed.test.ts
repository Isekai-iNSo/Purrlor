import { describe, expect, it } from 'vitest';
import { MatrixEvent, RoomType, type MatrixClient } from 'matrix-js-sdk';
import {
  dedupeSources,
  feedSourcesFromState,
  filterPosts,
  listDirectory,
  loadUserProfileSource,
  MAX_PROFILES,
  mapWithConcurrency,
  mergePosts,
  postsFromEvents,
  profileSourceFromState,
  toDirectoryProfile,
  toPublicSpace,
  type FeedSource,
} from './globalFeed';

const space = { roomId: '!space:example.org', name: 'Studio' };

function source(overrides: Partial<FeedSource> = {}): FeedSource {
  return {
    roomId: '!feed:example.org',
    owner: '@ana:example.org',
    ownerName: 'Ana',
    origin: { kind: 'space', spaceId: space.roomId, spaceName: space.name },
    isPublic: true,
    ...overrides,
  };
}

function post(eventId: string, ts: number, sender = '@ana:example.org', type = 'xyz.nekous.post', body = 'hello') {
  return new MatrixEvent({ event_id: eventId, type, sender, origin_server_ts: ts, room_id: '!feed:example.org', content: { body } });
}

const entry = (overrides: object) => ({ room_id: '!r:x', num_joined_members: 1, world_readable: true, guest_can_join: false, ...overrides });

describe('directory entries', () => {
  it('keeps Spaces as public spaces', () => {
    expect(toPublicSpace(entry({ name: 'S', room_type: RoomType.Space }))).toEqual({ roomId: '!r:x', name: 'S', worldReadable: true });
  });

  it('drops plain rooms, which have no posts', () => {
    expect(toPublicSpace(entry({ name: 'R' }))).toBeUndefined();
    expect(toDirectoryProfile(entry({ name: 'R' }))).toBeUndefined();
  });

  it('records a Space that does not open its state to non-members', () => {
    expect(toPublicSpace(entry({ world_readable: false, room_type: RoomType.Space }))?.worldReadable).toBe(false);
  });

  it('recognizes profile feeds, and only readable ones', () => {
    expect(toDirectoryProfile(entry({ name: 'Ana', room_type: 'xyz.nekous.profile' }))).toEqual({ roomId: '!r:x', name: 'Ana' });
    expect(toDirectoryProfile(entry({ world_readable: false, room_type: 'xyz.nekous.profile' }))).toBeUndefined();
  });
});

describe('feedSourcesFromState', () => {
  it('reads each joined member’s published feed room, tagged with the Space', () => {
    const sources = feedSourcesFromState(
      space,
      [
        {
          type: 'm.room.member',
          state_key: '@ana:example.org',
          content: { membership: 'join', displayname: 'Ana', 'xyz.nekous.feed_room': '!feed-ana:example.org' },
        },
        { type: 'm.room.member', state_key: '@ben:example.org', content: { membership: 'join', displayname: 'Ben' } },
      ],
      true
    );
    expect(sources).toEqual([
      {
        roomId: '!feed-ana:example.org',
        owner: '@ana:example.org',
        ownerName: 'Ana',
        origin: { kind: 'space', spaceId: space.roomId, spaceName: 'Studio' },
        isPublic: true,
      },
    ]);
  });

  it('ignores members who have left, so leaving takes your posts with you', () => {
    const sources = feedSourcesFromState(
      space,
      [{ type: 'm.room.member', state_key: '@cy:example.org', content: { membership: 'leave', 'xyz.nekous.feed_room': '!f:x' } }],
      true
    );
    expect(sources).toEqual([]);
  });
});

describe('profileSourceFromState', () => {
  const create = { type: 'm.room.create', state_key: '', sender: '@ana:example.org', content: { creator: '@ana:example.org' } };
  const member = { type: 'm.room.member', state_key: '@ana:example.org', content: { membership: 'join', displayname: 'Ana' } };

  it('reads the owner from the feed marker, as a public Global source', () => {
    const result = profileSourceFromState('!p:x', [
      create,
      member,
      { type: 'xyz.nekous.feed', state_key: '', content: { owner: '@ana:example.org', profile: true } },
    ]);
    expect(result).toEqual({
      roomId: '!p:x',
      owner: '@ana:example.org',
      ownerName: 'Ana',
      origin: { kind: 'global' },
      isPublic: true,
      follows: [],
    });
  });

  it('reads who the owner follows, skipping unfollows', () => {
    const result = profileSourceFromState('!p:x', [
      create,
      member,
      { type: 'xyz.nekous.feed', state_key: '', content: { owner: '@ana:example.org', profile: true } },
      { type: 'xyz.nekous.follow', state_key: '@bo:example.org', content: { following: true } },
      { type: 'xyz.nekous.follow', state_key: '@cy:example.org', content: {} },
    ]);
    expect(result?.follows).toEqual(['@bo:example.org']);
  });

  it('rejects a marker that names someone other than the room’s creator', () => {
    expect(
      profileSourceFromState('!p:x', [create, { type: 'xyz.nekous.feed', state_key: '', content: { owner: '@mallory:example.org' } }])
    ).toBeUndefined();
  });
});

describe('postsFromEvents', () => {
  it('keeps only posts by the feed’s owner', () => {
    const posts = postsFromEvents(source(), [
      post('$1', 10),
      post('$2', 20, '@intruder:example.org'),
      post('$3', 30, '@ana:example.org', 'm.room.message'),
    ]);
    expect(posts.map((p) => p.eventId)).toEqual(['$1']);
  });
});

describe('mergePosts', () => {
  it('sorts newest first and collapses duplicates of the same event', () => {
    const a = postsFromEvents(source(), [post('$old', 10), post('$mid', 20)]);
    const b = postsFromEvents(source(), [post('$new', 30), post('$mid', 20)]);
    expect(mergePosts(a, b).map((p) => p.eventId)).toEqual(['$new', '$mid', '$old']);
  });
});

describe('dedupeSources', () => {
  it('reads a room once, preferring its public identity', () => {
    const result = dedupeSources([source({ isPublic: false }), source({ isPublic: true })]);
    expect(result).toHaveLength(1);
    expect(result[0].isPublic).toBe(true);
  });
});

describe('filterPosts', () => {
  const publicPost = postsFromEvents(source({ roomId: '!pub:x' }), [post('$pub', 30)]);
  const privatePost = postsFromEvents(
    source({ roomId: '!priv:x', isPublic: false, origin: { kind: 'space', spaceId: '!secret:x', spaceName: 'Secret' } }),
    [post('$priv', 20)]
  );
  const benPost = postsFromEvents(
    source({ roomId: '!ben:x', owner: '@ben:example.org', origin: { kind: 'global' } }),
    [post('$ben', 10, '@ben:example.org')]
  );
  const all = mergePosts([], [...publicPost, ...privatePost, ...benPost]);

  it('Everyone never includes a post from a non-public Space', () => {
    expect(filterPosts(all, { kind: 'everyone' }).map((p) => p.eventId)).toEqual(['$pub', '$ben']);
  });

  it('Following matches followed people and followed Spaces', () => {
    expect(filterPosts(all, { kind: 'following', users: ['@ben:example.org'], spaces: [] }).map((p) => p.eventId)).toEqual(['$ben']);
    expect(filterPosts(all, { kind: 'following', users: [], spaces: ['!secret:x'] }).map((p) => p.eventId)).toEqual(['$priv']);
  });

  it('a profile shows everything by that person the viewer can read', () => {
    expect(filterPosts(all, { kind: 'profile', userId: '@ana:example.org' }).map((p) => p.eventId)).toEqual(['$pub', '$priv']);
  });
});

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once, and keeps results in order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('turns a failed item into undefined instead of failing the batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('nope');
      return n;
    });
    expect(results).toEqual([1, undefined, 3]);
  });
});

describe('listDirectory', () => {
  const profileEntry = (i: number) => entry({ room_id: `!p${i}:x`, room_type: 'xyz.nekous.profile', name: `P${i}` });

  it('says when the directory had more than the caps read', async () => {
    const mx = {
      publicRooms: async ({ since }: { since?: string }) => ({
        chunk: Array.from({ length: 50 }, (_, i) => profileEntry(Number(since ?? 0) + i)),
        next_batch: String(Number(since ?? 0) + 50),
      }),
    } as unknown as MatrixClient;
    const result = await listDirectory(mx);
    expect(result.profiles).toHaveLength(MAX_PROFILES);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when the whole directory was read', async () => {
    const mx = { publicRooms: async () => ({ chunk: [profileEntry(1)] }) } as unknown as MatrixClient;
    expect((await listDirectory(mx)).truncated).toBe(false);
  });
});

describe('loadUserProfileSource', () => {
  const profileState = (owner: string) => [
    { type: 'm.room.create', state_key: '', sender: owner, content: {} },
    { type: 'xyz.nekous.feed', state_key: '', content: { owner, profile: true } },
  ];

  it('finds a person’s profile feed from their user ID', async () => {
    const mx = {
      getExtendedProfile: async () => ({ 'xyz.nekous.profile_room': '!profile:x' }),
      roomState: async () => profileState('@bob:x'),
    } as unknown as MatrixClient;
    expect((await loadUserProfileSource(mx, '@bob:x'))?.roomId).toBe('!profile:x');
  });

  it('ignores a profile room pointer that belongs to someone else', async () => {
    const mx = {
      getExtendedProfile: async () => ({ 'xyz.nekous.profile_room': '!alices:x' }),
      roomState: async () => profileState('@alice:x'),
    } as unknown as MatrixClient;
    expect(await loadUserProfileSource(mx, '@bob:x')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { canRepost, feedJoinVia } from './feed';
import {
  buildCommentContent,
  COMMENT_EVENT_TYPE,
  LIKE_KEY,
  mergeNewestPage,
  REPOST_RECEIPT_TYPE,
  summarizeRelations,
  summarizeReposts,
  type RawRelationEvent,
} from './postInteractions';

const POST = '$post';
let seq = 0;

function like(sender: string, extra: Partial<RawRelationEvent> = {}, key = LIKE_KEY): RawRelationEvent {
  seq += 1;
  return {
    event_id: `$like${seq}`,
    type: 'm.reaction',
    sender,
    origin_server_ts: seq,
    content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: POST, key } },
    ...extra,
  };
}

function comment(sender: string, body: string, ts: number, extra: Partial<RawRelationEvent> = {}): RawRelationEvent {
  seq += 1;
  return {
    event_id: `$comment${seq}`,
    type: COMMENT_EVENT_TYPE,
    sender,
    origin_server_ts: ts,
    content: { body, 'm.relates_to': { rel_type: 'm.reference', event_id: POST } },
    ...extra,
  };
}

describe('summarizeRelations', () => {
  it('counts one like per person and remembers your own', () => {
    const mine = like('@me:x');
    const summary = summarizeRelations([like('@a:x'), like('@a:x'), mine, like('@b:x')], POST, '@me:x');
    expect(summary.likeCount).toBe(3);
    expect(summary.myLikeId).toBe(mine.event_id);
  });

  it('ignores reactions that are not the like key', () => {
    expect(summarizeRelations([like('@a:x', {}, '😂')], POST, '@me:x').likeCount).toBe(0);
  });

  // What Continuwuity actually returns for an un-liked (redacted) reaction: still in /relations,
  // with its content stripped and redacted_because set.
  it('drops redacted likes and comments', () => {
    const redacted = { content: {}, unsigned: { redacted_because: { type: 'm.room.redaction' } } };
    const summary = summarizeRelations([like('@me:x', redacted), comment('@a:x', 'gone', 5, redacted)], POST, '@me:x');
    expect(summary).toEqual({ likeCount: 0, likers: [], myLikeId: undefined, comments: [] });
  });

  it('keeps comments oldest first, with their media', () => {
    const image = { kind: 'image', url: 'mxc://x/a', name: 'a.webp', info: { mimetype: 'image/webp', size: 1 } };
    const withMedia = comment('@b:x', '', 1, {
      content: { body: '', 'xyz.nekous.attachments': [image], 'm.relates_to': { rel_type: 'm.reference', event_id: POST } },
    });
    const summary = summarizeRelations([comment('@a:x', 'second', 2), withMedia], POST, '@me:x');
    expect(summary.comments.map((c) => c.sender)).toEqual(['@b:x', '@a:x']);
    expect(summary.comments[0].content.attachments).toHaveLength(1);
  });

  it('ignores relations to some other event, and empty comments', () => {
    const elsewhere = comment('@a:x', 'hi', 1, {
      content: { body: 'hi', 'm.relates_to': { rel_type: 'm.reference', event_id: '$other' } },
    });
    expect(summarizeRelations([elsewhere, comment('@a:x', '', 2)], POST, '@me:x').comments).toEqual([]);
  });
});

describe('buildCommentContent', () => {
  it('relates to the post and carries media under the post key, never a repost', () => {
    const image = { kind: 'image' as const, url: 'mxc://x/a', name: 'a.webp', info: { mimetype: 'image/webp', size: 1 } };
    const content = buildCommentContent(POST, {
      body: 'look',
      attachments: [image],
      repostOf: { roomId: '!r', eventId: '$e', sender: '@s', senderName: 's', origin: { kind: 'global' }, ts: 0, body: 'x' },
    });
    expect(content).toEqual({
      body: 'look',
      'xyz.nekous.attachments': [image],
      'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    });
  });
});

describe('canRepost within one Space', () => {
  const inSpace = { kind: 'space' as const, spaceId: '!s', spaceName: 'S' };
  it('allows a private Space post to be reposted inside that same Space only', () => {
    expect(canRepost(inSpace, false, inSpace, false)).toBe(true);
    expect(canRepost(inSpace, false, { kind: 'space', spaceId: '!other', spaceName: 'O' }, false)).toBe(false);
    expect(canRepost(inSpace, false, { kind: 'global' }, true)).toBe(false);
  });
});

describe('feedJoinVia', () => {
  it("joins through the owner's server when the room ID names none (room version 12)", () => {
    expect(feedJoinVia('!x9JRGISwPm5nu5FI9f', '@alice:example.org')).toEqual(['example.org']);
  });

  it('uses both, without duplicates, for an older room ID', () => {
    expect(feedJoinVia('!abc:example.org', '@alice:example.org')).toEqual(['example.org']);
    expect(feedJoinVia('!abc:other.org', '@alice:example.org')).toEqual(['example.org', 'other.org']);
  });
});

describe('mergeNewestPage', () => {
  const c = (id: string, ts: number) => ({ eventId: id, sender: '@a:x', ts, content: { body: id } });

  it('keeps older pages loaded earlier and takes the fresh page for everything it covers', () => {
    const loaded = [c('old1', 1), c('old2', 2), c('mid', 5), c('deleted', 6), c('new', 7)];
    const fresh = [c('mid', 5), c('new', 7), c('newer', 8)];
    expect(mergeNewestPage(loaded, fresh).map((x) => x.eventId)).toEqual(['old1', 'old2', 'mid', 'new', 'newer']);
  });

  it('is empty when the thread has no comments left', () => {
    expect(mergeNewestPage([c('a', 1)], [])).toEqual([]);
  });
});

describe('replies to comments', () => {
  it('names the comment answered and mentions its author, which is what notifies them', () => {
    const content = buildCommentContent(POST, { body: 'agreed' }, { replyTo: { eventId: '$c1', sender: '@bob:x' }, myUserId: '@me:x' });
    expect(content['xyz.nekous.reply_to']).toEqual({ event_id: '$c1', sender: '@bob:x' });
    expect(content['m.mentions']).toEqual({ user_ids: ['@bob:x'] });
  });

  it("doesn't mention you when you reply to yourself", () => {
    const content = buildCommentContent(POST, { body: 'also' }, { replyTo: { eventId: '$c1', sender: '@me:x' }, myUserId: '@me:x' });
    expect(content['xyz.nekous.reply_to']).toBeDefined();
    expect(content['m.mentions']).toBeUndefined();
  });

  it('mentions whoever was picked from the autocomplete as well as the person replied to', () => {
    const content = buildCommentContent(
      POST,
      { body: 'agreed @Carol', mentions: ['@carol:x', '@bob:x', '@me:x'] },
      { replyTo: { eventId: '$c1', sender: '@bob:x' }, myUserId: '@me:x' }
    );
    expect(content['m.mentions']).toEqual({ user_ids: ['@carol:x', '@bob:x'] });
  });

  it('a plain comment mentions nobody', () => {
    expect(buildCommentContent(POST, { body: 'hi' })['m.mentions']).toBeUndefined();
  });

  it('reads the reply target back off a comment', () => {
    const reply = comment('@carol:x', 'agreed', 3, {
      content: {
        body: 'agreed',
        'xyz.nekous.reply_to': { event_id: '$c1', sender: '@bob:x' },
        'm.relates_to': { rel_type: 'm.reference', event_id: POST },
      },
    });
    expect(summarizeRelations([reply], POST, '@me:x').comments[0].replyTo).toEqual({ eventId: '$c1', sender: '@bob:x' });
  });
});

describe('summarizeReposts', () => {
  const receipt = (sender: string, eventId: string, extra: Partial<RawRelationEvent> = {}): RawRelationEvent => ({
    event_id: `$receipt-${eventId}`,
    type: REPOST_RECEIPT_TYPE,
    sender,
    origin_server_ts: 1,
    content: {
      'xyz.nekous.repost_event': { room_id: '!mine', event_id: eventId, quote: false },
      'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    },
    ...extra,
  });

  it('counts each reposter once and finds your own repost to undo', () => {
    const summary = summarizeReposts([receipt('@a:x', '$r1'), receipt('@a:x', '$r2'), receipt('@me:x', '$r3')], POST, '@me:x');
    expect(summary.repostCount).toBe(2);
    expect(summary.mine).toEqual({ receiptId: '$receipt-$r3', roomId: '!mine', eventId: '$r3' });
  });

  it('ignores undone reposts and markers for other posts', () => {
    const undone = receipt('@me:x', '$r1', { content: {}, unsigned: { redacted_because: {} } });
    const elsewhere = receipt('@b:x', '$r2', {
      content: { 'm.relates_to': { rel_type: 'm.reference', event_id: '$other' } },
    });
    expect(summarizeReposts([undone, elsewhere], POST, '@me:x')).toEqual({ repostCount: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import { buildActivity, type RawActivityEvent } from './activity';

const ME = '@me:x';
const POST = '$post';
let seq = 0;

function ev(type: string, sender: string, ts: number, content: Record<string, unknown>): RawActivityEvent {
  seq += 1;
  return { event_id: `$e${seq}`, room_id: '!mine', type, sender, origin_server_ts: ts, content };
}

const like = (sender: string, ts: number, post = POST) =>
  ev('m.reaction', sender, ts, { 'm.relates_to': { rel_type: 'm.annotation', event_id: post, key: '❤️' } });

const comment = (sender: string, ts: number, replyTo?: string) =>
  ev('xyz.nekous.comment', sender, ts, {
    body: 'hi',
    'm.relates_to': { rel_type: 'm.reference', event_id: POST },
    ...(replyTo && { 'xyz.nekous.reply_to': { event_id: '$c', sender: replyTo } }),
  });

const repost = (sender: string, ts: number, quote = false) =>
  ev('xyz.nekous.repost', sender, ts, {
    'xyz.nekous.repost_event': { room_id: '!theirs', event_id: `$q${ts}`, quote },
    'm.relates_to': { rel_type: 'm.reference', event_id: POST },
  });

describe('buildActivity', () => {
  it('groups likes per post, newest liker first, and keeps comments separate', () => {
    const rows = buildActivity([like('@a:x', 1), like('@b:x', 3), comment('@c:x', 2), like('@a:x', 4, '$other')], ME);
    expect(rows.map((row) => [row.kind, row.senders])).toEqual([
      ['like', ['@a:x']],
      ['like', ['@b:x', '@a:x']],
      ['comment', ['@c:x']],
    ]);
    expect(rows[1]).toMatchObject({ postId: POST, ts: 3 });
  });

  it('tells a reply to you from a comment, and a quote from a repost', () => {
    const rows = buildActivity(
      [comment('@a:x', 1, ME), comment('@b:x', 2, '@b:x'), repost('@c:x', 3), repost('@d:x', 4, true)],
      ME
    );
    expect(rows.map((row) => row.kind)).toEqual(['quote', 'repost', 'comment', 'reply']);
    expect(rows[0].quote).toEqual({ roomId: '!theirs', eventId: '$q4' });
  });

  it('skips your own actions, undone ones, and other reactions', () => {
    const undone = { ...like('@a:x', 2), unsigned: { redacted_because: {} } };
    const laugh = ev('m.reaction', '@b:x', 3, { 'm.relates_to': { rel_type: 'm.annotation', event_id: POST, key: '😂' } });
    expect(buildActivity([like(ME, 1), undone, laugh], ME)).toEqual([]);
  });

  it('puts one day of new followers in one row', () => {
    const day = new Date(2026, 8, 26, 10).getTime();
    const rows = buildActivity(
      [
        ev('xyz.nekous.followed', '@a:x', day, {}),
        ev('xyz.nekous.followed', '@b:x', day + 1000, {}),
        ev('xyz.nekous.followed', '@c:x', day - 86_400_000, {}),
      ],
      ME
    );
    expect(rows.map((row) => row.senders)).toEqual([['@b:x', '@a:x'], ['@c:x']]);
  });
});

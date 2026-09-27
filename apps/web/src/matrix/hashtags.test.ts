import { describe, expect, it } from 'vitest';
import { extractHashtags, parsePostQuery, postMatchesQuery } from './hashtags';

describe('extractHashtags', () => {
  it('finds tags, lowercased and once each', () => {
    expect(extractHashtags('Morning #Cats! more #cats and #caturday_2026')).toEqual(['cats', 'caturday_2026']);
  });

  it('skips numbers, words with # inside, and URL fragments', () => {
    expect(extractHashtags('#1 fan of C# and a#b, see https://x.org/page#section')).toEqual([]);
  });

  it('reads non-English tags', () => {
    expect(extractHashtags('#ねこ #café')).toEqual(['ねこ', 'café']);
  });
});

describe('search', () => {
  const post = { body: 'Napping in the sun #Caturday', repostOf: undefined };

  it('treats a lone #word as a tag and anything else as words', () => {
    expect(parsePostQuery(' #CatURDAY ')).toEqual({ kind: 'tag', tag: 'caturday' });
    expect(parsePostQuery('sun nap')).toEqual({ kind: 'text', words: ['sun', 'nap'] });
    expect(parsePostQuery('   ')).toEqual({ kind: 'none' });
  });

  it('matches a tag exactly, and words in any order and case', () => {
    expect(postMatchesQuery(post, parsePostQuery('#caturday'))).toBe(true);
    expect(postMatchesQuery(post, parsePostQuery('#cat'))).toBe(false);
    expect(postMatchesQuery(post, parsePostQuery('SUN napping'))).toBe(true);
    expect(postMatchesQuery(post, parsePostQuery('sun moon'))).toBe(false);
  });

  it("finds a post by its author's name, and a repost by what it quotes", () => {
    expect(postMatchesQuery(post, parsePostQuery('nibbles'), 'Nibbles')).toBe(true);
    const repost = {
      body: '',
      repostOf: { roomId: '!r', eventId: '$e', sender: '@a:x', senderName: 'Pixel', origin: { kind: 'global' as const }, ts: 1, body: 'look #art' },
    };
    expect(postMatchesQuery(repost, parsePostQuery('#art'))).toBe(true);
    expect(postMatchesQuery(repost, parsePostQuery('pixel'))).toBe(true);
  });
});

import type { PostContent } from './feed';

/**
 * Hashtags and post search. There's no server-side index to ask — posts are ordinary events in
 * many rooms — so both run over the posts a timeline has already loaded, and a search that wants
 * more reads further back the same way scrolling does.
 *
 * A tag is `#` then letters, digits or underscores, with at least one letter (so `#1` isn't one),
 * not glued to the end of a word (so `C#` and `a#b` aren't) or part of a URL fragment (the URL
 * match claims that text first when rendering). Tags compare case-insensitively.
 */
export const HASHTAG_PATTERN = /(?<![\p{L}\p{N}_&#/])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu;

const MAX_TAG_LENGTH = 64;

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').toLowerCase();
}

/** Every distinct tag in a text, lowercased, in the order they first appear. */
export function extractHashtags(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    if (match[1].length <= MAX_TAG_LENGTH) seen.add(match[1].toLowerCase());
  }
  return [...seen];
}

export type PostQuery = { kind: 'tag'; tag: string } | { kind: 'text'; words: string[] } | { kind: 'none' };

/** What a search box's text asks for: `#cats` is a tag; anything else is words, all of which
 *  must appear (in any order, any case). */
export function parsePostQuery(raw: string): PostQuery {
  const text = raw.trim();
  if (!text) return { kind: 'none' };
  if (/^#[^\s#]+$/.test(text)) return { kind: 'tag', tag: normalizeTag(text) };
  return { kind: 'text', words: text.toLowerCase().split(/\s+/) };
}

/** Whether a post answers a query. A repost matches on what it quotes too — searching for a
 *  quoted post's words should find the repost. `authorName` lets a search find someone by name. */
export function postMatchesQuery(content: PostContent, query: PostQuery, authorName = ''): boolean {
  const texts = [content.body, content.warning ?? '', content.repostOf?.body ?? '', content.repostOf?.senderName ?? ''];
  switch (query.kind) {
    case 'none':
      return true;
    case 'tag':
      return texts.some((text) => extractHashtags(text).includes(query.tag));
    case 'text': {
      const haystack = [...texts, authorName].join('\n').toLowerCase();
      return query.words.every((word) => haystack.includes(word));
    }
    default:
      return false;
  }
}

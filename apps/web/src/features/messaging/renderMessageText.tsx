import type { ReactNode } from 'react';
import type { RoomMember } from 'matrix-js-sdk';
import type { Emote } from '../../matrix/emotes';
import { HASHTAG_PATTERN, normalizeTag } from '../../matrix/hashtags';
import { CodeBlock } from './CodeBlock';
import { EmoteImage } from './EmoteImage';
import { SpoilerText } from './SpoilerText';

// Trailing punctuation that's almost always sentence structure rather than part of the URL
// itself (a period ending the sentence, a comma before "and", a closing paren that opened
// before the URL started) is excluded from the match — same convention Element/Discord use.
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,!?;:')\]]/g;
const SHORTCODE_PATTERN = /:([a-zA-Z0-9_+-]+):/g;
// Matched (and its span fully claimed via the same index-based overlap resolution as everything
// else here) before the single-line CODE_PATTERN gets a chance at it, so a ``` fence's content
// never also gets inline-code/bold/italic treatment applied inside it.
const FENCE_PATTERN = /```(\w*)\n?([\s\S]*?)```/g;
// Rendered purely from the literal text, independent of whether the sender's own client actually
// had permission to set `m.mentions.room` — this is cosmetic highlighting, not a claim about
// whether it actually notified anyone.
const ROOM_MENTION_PATTERN = /@room\b/g;

// Order doesn't actually matter for priority here — see the comment below on how overlap
// resolution (by match *index*, not array order) is what makes e.g. `**bold**` win over a
// spurious `*bold*` italic match starting one character in. Newlines are excluded from every
// span's content so formatting can't accidentally swallow a whole paragraph break.
// The (?!\s)/(?<!\s) guards (no whitespace right inside either delimiter) are what stop a lone
// stray "*" left over after "**bold**" from bridging across the following space and eating the
// next real "*italic*"'s opening delimiter — without them, matchAll's non-overlapping left-to-
// right scan would consume "* *" as a bogus single-space italic and never see the real one.
const CODE_PATTERN = /`([^`\n]+)`/g;
const BOLD_PATTERN = /\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g;
const STRIKE_PATTERN = /~~(?!\s)([^~\n]+?)(?<!\s)~~/g;
const SPOILER_PATTERN = /\|\|(?!\s)([^|\n]+?)(?<!\s)\|\|/g;
const ITALIC_STAR_PATTERN = /\*(?!\s)([^*\n]+?)(?<!\s)\*/g;
const ITALIC_UNDERSCORE_PATTERN = /_(?!\s)([^_\n]+?)(?<!\s)_/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First bare URL in a message body, if any — used to decide whether to fetch/show a link
 *  preview card below the message, matching Element/Discord's "unfurl the first link" rule. */
export function extractFirstUrl(text: string): string | undefined {
  // A fresh RegExp instance rather than exec()-ing the shared module-level URL_PATTERN: that
  // pattern is also `matchAll`'d elsewhere (renderMessageText below), and matchAll clones a
  // global regex's *current* lastIndex — so a stateful exec() here would leave later scans
  // silently starting mid-string and missing the very match this function just found.
  return new RegExp(URL_PATTERN.source, URL_PATTERN.flags).exec(text)?.[0];
}

type Match = { index: number; length: number; node: ReactNode };

function pushPatternMatches(
  matches: Match[],
  text: string,
  pattern: RegExp,
  build: (content: string) => ReactNode
): void {
  for (const match of text.matchAll(pattern)) {
    matches.push({ index: match.index, length: match[0].length, node: build(match[1]) });
  }
}

/**
 * Renders message text with purely text-pattern substitutions — never a sender's
 * `formatted_body` HTML (kept out of scope deliberately, same reasoning throughout this app:
 * safety, and rendering consistently regardless of which client sent the message):
 * `:shortcode:` emotes matching a known room emote (MSC2545), `@DisplayName` mentions matching a
 * current room member, a literal `@room` mass-mention (highlighted regardless of whether the
 * sender actually had permission to trigger it — this only reflects the text, not whether it
 * notified anyone), and basic Markdown (`**bold**`, `*italic*`/`_italic_`, `` `code` ``,
 * `~~strikethrough~~`, `||spoiler||`, and a `` ```lang\ncode\n``` `` fenced block, syntax-
 * highlighted client-side for a handful of common languages — see CodeBlock.tsx) — the same
 * plain-text convention Element's
 * own composer relies on (it puts the Markdown source in `body` and a rendered version in
 * `formatted_body`), so this renders consistently no matter which client sent it. All of these
 * are collected into one flat list of non-overlapping spans and sorted by *position* — that's
 * what makes `**bold**` win over the spurious `*bold*` an italic scan would otherwise also match
 * starting one character later, and what keeps Markdown from being parsed a second time inside
 * an inline code span: whichever match starts first claims that stretch of text, so nothing
 * else is deliberately supported nested inside another (e.g. an emote inside bold text just
 * renders as literal characters) — a scope cut like several others in this app, not a bug.
 */
export function renderMessageText(
  text: string,
  emotes: Emote[],
  members: RoomMember[] = [],
  myUserId?: string,
  /** Posts only: `#tags` become buttons that open that tag's timeline (hashtags.ts). */
  options: { onHashtag?: (tag: string) => void } = {}
): ReactNode {
  const matches: Match[] = [];
  let key = 0;
  const { onHashtag } = options;

  if (onHashtag) {
    for (const match of text.matchAll(HASHTAG_PATTERN)) {
      const tag = normalizeTag(match[1]);
      matches.push({
        index: match.index,
        length: match[0].length,
        node: (
          <button key={key++} type="button" className="nu-hashtag" data-nu-role="hashtag" onClick={() => onHashtag(tag)}>
            {match[0]}
          </button>
        ),
      });
    }
  }

  if (emotes.length > 0) {
    const byShortcode = new Map(emotes.map((emote) => [emote.shortcode, emote]));
    for (const match of text.matchAll(SHORTCODE_PATTERN)) {
      const emote = byShortcode.get(match[1]);
      if (!emote) continue;
      matches.push({
        index: match.index,
        length: match[0].length,
        node: <EmoteImage key={key++} shortcode={emote.shortcode} mxcUrl={emote.mxcUrl} />,
      });
    }
  }

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    matches.push({
      index: match.index,
      length: url.length,
      node: (
        <a key={key++} href={url} target="_blank" rel="noopener noreferrer" className="nu-message-link">
          {url}
        </a>
      ),
    });
  }

  for (const match of text.matchAll(ROOM_MENTION_PATTERN)) {
    matches.push({
      index: match.index,
      length: match[0].length,
      node: (
        <span key={key++} className="nu-mention nu-mention--room">
          {match[0]}
        </span>
      ),
    });
  }

  for (const member of members) {
    if (!member.name) continue;
    const pattern = new RegExp(`@${escapeRegExp(member.name)}\\b`, 'g');
    for (const match of text.matchAll(pattern)) {
      matches.push({
        index: match.index,
        length: match[0].length,
        node: (
          <span key={key++} className={member.userId === myUserId ? 'nu-mention nu-mention--me' : 'nu-mention'}>
            {match[0]}
          </span>
        ),
      });
    }
  }

  for (const match of text.matchAll(FENCE_PATTERN)) {
    matches.push({
      index: match.index,
      length: match[0].length,
      node: <CodeBlock key={key++} code={match[2]} language={match[1]} />,
    });
  }

  pushPatternMatches(matches, text, CODE_PATTERN, (content) => (
    <code key={key++} className="nu-inline-code">
      {content}
    </code>
  ));
  pushPatternMatches(matches, text, BOLD_PATTERN, (content) => <strong key={key++}>{content}</strong>);
  pushPatternMatches(matches, text, STRIKE_PATTERN, (content) => <del key={key++}>{content}</del>);
  pushPatternMatches(matches, text, SPOILER_PATTERN, (content) => <SpoilerText key={key++}>{content}</SpoilerText>);
  pushPatternMatches(matches, text, ITALIC_STAR_PATTERN, (content) => <em key={key++}>{content}</em>);
  pushPatternMatches(matches, text, ITALIC_UNDERSCORE_PATTERN, (content) => <em key={key++}>{content}</em>);

  if (matches.length === 0) return text;
  matches.sort((a, b) => a.index - b.index);

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    if (match.index < lastIndex) continue; // overlapping match — keep the earlier one
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(match.node);
    lastIndex = match.index + match.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

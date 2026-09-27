import { POST_MAX_LENGTH, postLength } from '../../matrix/feed';

/** Characters left before the post cap — shown quietly, warning near the end, red past it. */
export function CharCounter({ text, max = POST_MAX_LENGTH }: { text: string; max?: number }) {
  const left = max - postLength(text);
  const state = left < 0 ? 'over' : left <= 20 ? 'near' : 'ok';
  return (
    <span className={`nu-char-counter nu-char-counter--${state}`} data-nu-role="char-counter" aria-live="polite">
      {left}
    </span>
  );
}

export function isOverLimit(text: string, max = POST_MAX_LENGTH): boolean {
  return postLength(text) > max;
}

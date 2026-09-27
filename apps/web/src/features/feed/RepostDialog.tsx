import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import type { RepostOf } from '../../matrix/feed';
import type { FeedSource } from '../../matrix/globalFeed';
import { buildMessageFormatting } from '../../matrix/messageFormatting';
import { repostToTarget } from '../../matrix/postPublishing';
import { useOwnProfile } from '../../matrix/hooks/useOwnProfile';
import { CharCounter, isOverLimit } from './CharCounter';
import type { ComposerTarget } from './PostComposer';
import { PostCard } from './PostCard';

/**
 * Quoting a post: your own words above it, then the post. (A plain repost needs no dialog — see
 * InteractivePost.) The caller passes only the targets canRepost allows for this post
 * (repostTargetsFor): public places for a public post, or the same Space for a post from a
 * private one — so a quote never carries content somewhere more visible than it already was.
 */
export function RepostDialog({
  repostOf,
  targets,
  onClose,
  onReposted,
}: {
  repostOf: RepostOf;
  /** Already narrowed by the caller. */
  targets: ComposerTarget[];
  onClose: () => void;
  onReposted?: (source: FeedSource) => void;
}) {
  const mx = useMatrixClient();
  const myUserId = mx.getUserId() ?? '';
  const { displayName } = useOwnProfile();
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const target = targets.find((t) => t.id === targetId);
  const tooLong = isOverLimit(comment);

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (!target || busy || tooLong) return;
    setBusy(true);
    setError(undefined);
    try {
      const body = comment.trim();
      const { formattedBody } = buildMessageFormatting(body, [], []);
      const { source } = await repostToTarget(mx, target.target, repostOf, displayName || myUserId, target.isPublic, {
        body,
        formattedBody,
      });
      onReposted?.(source);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t post that quote');
      setBusy(false);
    }
  };

  return (
    <Modal title="Quote post" onClose={onClose} wide>
      <form className="nu-modal-form" onSubmit={handleSubmit} data-nu-role="repost-dialog">
        <label className="nu-field">
          Your comment
          <textarea
            className="nu-field__textarea"
            data-nu-role="repost-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={3}
            autoFocus
          />
        </label>
        <div className="nu-quote-dialog__meta">
          {targets.length > 1 ? (
            <label className="nu-post-composer__target">
              <span className="nu-post-composer__target-label">Post to</span>
              <select
                className="nu-post-composer__select"
                data-nu-role="repost-target"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="nu-post-composer__target-label">Posting to {target?.label}</span>
          )}
          <CharCounter text={comment} />
        </div>
        <PostCard
          content={{
            body: repostOf.body,
            ...(repostOf.attachments && { attachments: repostOf.attachments }),
            ...(repostOf.warning && { warning: repostOf.warning }),
            ...(repostOf.sensitive && { sensitive: true }),
          }}
          author={{ userId: repostOf.sender, name: repostOf.senderName }}
          origin={repostOf.origin}
          ts={repostOf.ts}
          myUserId={myUserId}
          role="repost-preview"
        />
        {error && <p className="nu-field__error">{error}</p>}
        <div className="nu-form-actions">
          <button type="button" className="nu-button nu-button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="nu-button nu-button--primary"
            data-nu-role="repost-submit"
            disabled={busy || !target || tooLong}
          >
            {busy ? 'Posting…' : 'Quote'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

import { useSetAtom } from 'jotai';
import { openPostAtom } from '../../app/state/selection';
import { Icon } from '../../components/Icon';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { readPost } from '../../matrix/feed';
import type { GlobalPost } from '../../matrix/globalFeed';
import { useAttachmentUrl } from '../../matrix/hooks/useAttachmentUrl';
import type { PostAttachment } from '../../matrix/postMedia';
import { openPostFrom } from './profileData';
import './MediaGrid.css';

function Tile({ attachment, covered }: { attachment: PostAttachment; covered: boolean }) {
  const src = useAttachmentUrl({ url: attachment.url, file: attachment.file, mimetype: attachment.info.mimetype });
  if (!src) return <span className="nu-media-grid__fill nu-media-grid__fill--loading" />;
  const className = covered ? 'nu-media-grid__fill nu-media-grid__fill--covered' : 'nu-media-grid__fill';
  return attachment.kind === 'video' ? (
    <video className={className} src={src} muted playsInline preload="metadata" />
  ) : (
    <img className={className} src={src} alt={attachment.name} loading="lazy" />
  );
}

/**
 * A profile's Media tab: every post with images or video, as square tiles, newest first. A tile
 * opens its post. Media behind a content warning or marked sensitive stays blurred here too.
 */
export function MediaGrid({ posts }: { posts: GlobalPost[] }) {
  const mx = useMatrixClient();
  const setOpenPost = useSetAtom(openPostAtom);
  const withMedia = posts.flatMap((post) => {
    const content = readPost(post.event);
    return content?.attachments?.length ? [{ post, content }] : [];
  });

  if (withMedia.length === 0) return null;
  return (
    <div className="nu-media-grid" data-nu-role="profile-media-grid">
      {withMedia.map(({ post, content }) => {
        const covered = !!content.warning || !!content.sensitive;
        const attachments = content.attachments ?? [];
        const origin = post.source.origin;
        const member = origin.kind === 'global' || mx.getRoom(origin.spaceId)?.getMyMembership() === 'join';
        return (
          <button
            key={post.eventId}
            type="button"
            className="nu-media-grid__tile"
            data-nu-role="profile-media-tile"
            title={content.warning ?? content.body.slice(0, 120)}
            onClick={() => {
              const open = openPostFrom(
                post,
                member,
                origin.kind === 'space' ? `Join ${origin.spaceName} to like, comment or report.` : undefined
              );
              if (open) setOpenPost(open);
            }}
          >
            <Tile attachment={attachments[0]} covered={covered} />
            {covered && (
              <span className="nu-media-grid__badge nu-media-grid__badge--covered">
                <Icon name="eyeOff" size={14} />
              </span>
            )}
            {attachments.length > 1 && <span className="nu-media-grid__badge">+{attachments.length - 1}</span>}
          </button>
        );
      })}
    </div>
  );
}

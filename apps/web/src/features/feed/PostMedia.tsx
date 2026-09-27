import { useState, type CSSProperties } from 'react';
import { Icon } from '../../components/Icon';
import { Lightbox } from '../../components/Lightbox';
import { useAttachmentUrl } from '../../matrix/hooks/useAttachmentUrl';
import { attachmentMxc, type PostAttachment } from '../../matrix/postMedia';
import './PostMedia.css';

function ratioStyle(attachment: PostAttachment): CSSProperties | undefined {
  const { w, h } = attachment.info;
  return w && h ? { aspectRatio: `${w} / ${h}` } : undefined;
}

function MediaItem({ attachment, single }: { attachment: PostAttachment; single: boolean }) {
  // An encrypted attachment is fetched and decrypted here with the key from the post itself.
  const src = useAttachmentUrl({ url: attachment.url, file: attachment.file, mimetype: attachment.info.mimetype });
  const [open, setOpen] = useState(false);
  // One item keeps its own shape (reserved up front from w/h, so nothing jumps when it loads);
  // in a grid every cell is square and the media is cropped to fill it.
  const style = single ? ratioStyle(attachment) : undefined;

  if (!src) {
    return <div className="nu-post-media__item nu-post-media__item--loading" data-nu-role="post-media-loading" style={style} />;
  }

  if (attachment.kind === 'video') {
    return (
      <div className="nu-post-media__item" style={style}>
        {/* WebM/MP4 posts are often GIF replacements; muted + loop keeps that feel, and the
            controls are there for anything with sound. */}
        <video
          className="nu-post-media__video"
          data-nu-role="post-media-video"
          src={src}
          controls
          loop
          muted
          playsInline
          preload="metadata"
        />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="nu-post-media__item nu-post-media__item--image"
        data-nu-role="post-media-image"
        style={style}
        onClick={() => setOpen(true)}
      >
        <img className="nu-post-media__img" src={src} alt={attachment.name} loading="lazy" />
      </button>
      {open && <Lightbox src={src} alt={attachment.name} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * A post's images and videos: one shown at its own shape, two to four as a grid. Media its author
 * marked sensitive is blurred, with nothing playable or openable, until the reader asks to see it.
 */
export function PostMedia({ attachments, sensitive = false }: { attachments: PostAttachment[]; sensitive?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  if (attachments.length === 0) return null;
  const single = attachments.length === 1;
  const covered = sensitive && !revealed;
  return (
    <div
      className={[
        'nu-post-media',
        `nu-post-media--count-${attachments.length}`,
        covered && 'nu-post-media--covered',
      ]
        .filter(Boolean)
        .join(' ')}
      data-nu-role="post-media"
    >
      {attachments.map((attachment) => (
        <MediaItem key={attachmentMxc(attachment)} attachment={attachment} single={single} />
      ))}
      {covered && (
        <button type="button" className="nu-post-media__reveal" data-nu-role="post-media-reveal" onClick={() => setRevealed(true)}>
          <Icon name="eyeOff" size={18} />
          Sensitive media
          <span className="nu-post-media__reveal-hint">Show</span>
        </button>
      )}
    </div>
  );
}

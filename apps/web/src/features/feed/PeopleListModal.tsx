import { useSetAtom } from 'jotai';
import { openPostAtom, profileUserIdAtom } from '../../app/state/selection';
import { Avatar } from '../../components/Avatar';
import { Modal } from '../../components/Modal';
import { useMatrixClient } from '../../matrix/MatrixClientContext';
import { setFollowing } from '../../matrix/follows';
import { useFollows } from '../../matrix/hooks/useFollows';
import { useUserProfile } from '../../matrix/hooks/useUserProfile';
import { handleFor } from '../../matrix/roles';
import './PeopleListModal.css';

function PersonRow({ userId, following, onOpen }: { userId: string; following: boolean; onOpen: () => void }) {
  const mx = useMatrixClient();
  const profile = useUserProfile(userId);
  const isMe = userId === mx.getUserId();
  return (
    <li className="nu-people__row" data-nu-role="people-row">
      <button type="button" className="nu-people__person" onClick={onOpen}>
        <Avatar name={profile.name} mxcUrl={profile.avatarUrl} size={36} />
        <span className="nu-people__names">
          <span className="nu-people__name">{profile.name}</span>
          <span className="nu-people__handle">{handleFor(userId)}</span>
        </span>
      </button>
      {!isMe && (
        <button
          type="button"
          className={following ? 'nu-follow-button nu-follow-button--on' : 'nu-follow-button'}
          data-nu-role="people-follow"
          aria-pressed={following}
          onClick={() => void setFollowing(mx, 'user', userId).catch(() => undefined)}
        >
          {following ? 'Following' : 'Follow'}
        </button>
      )}
    </li>
  );
}

/** A list of people — who liked a post, someone's followers or who they follow. Tapping a person
 *  opens their profile. */
export function PeopleListModal({
  title,
  userIds,
  emptyText,
  note,
  onClose,
}: {
  title: string;
  userIds: string[];
  emptyText: string;
  /** Anything the reader should know about how complete the list is. */
  note?: string;
  onClose: () => void;
}) {
  const follows = useFollows();
  const setProfileUserId = useSetAtom(profileUserIdAtom);
  const setOpenPost = useSetAtom(openPostAtom);
  const open = (userId: string) => {
    onClose();
    setOpenPost(null);
    setProfileUserId(userId);
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="nu-people" data-nu-role="people-list">
        {userIds.length === 0 ? (
          <p className="nu-people__empty">{emptyText}</p>
        ) : (
          <ul className="nu-people__list">
            {userIds.map((userId) => (
              <PersonRow key={userId} userId={userId} following={follows.users.includes(userId)} onOpen={() => open(userId)} />
            ))}
          </ul>
        )}
        {note && <p className="nu-people__note">{note}</p>}
      </div>
    </Modal>
  );
}

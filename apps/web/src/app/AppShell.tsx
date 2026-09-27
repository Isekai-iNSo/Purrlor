import { useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { ServerRail } from '../features/servers/ServerRail';
import { ChannelList } from '../features/channels/ChannelList';
import { MainPane } from '../features/messaging/MainPane';
import { MemberList } from '../features/members/MemberList';
import { DesktopNotifications } from '../features/notifications/DesktopNotifications';
import { PostNotificationRules } from '../features/notifications/PostNotificationRules';
import { FeedGovernance } from '../features/feed/FeedGovernance';
import { ActivityWatcher } from '../features/notifications/ActivityWatcher';
import { MentionInboxCollector } from '../features/notifications/MentionInboxCollector';
import { MentionInviteAcceptor } from '../features/notifications/MentionInviteAcceptor';
import { SpaceAutoJoiner } from '../features/servers/SpaceAutoJoiner';
import { IncomingVerificationListener } from '../features/security/IncomingVerificationListener';
import { RecoveryKeyPrompt } from '../features/security/RecoveryKeyPrompt';
import { VoiceCallSession } from '../features/voice/VoiceCallSession';
import { DemoModeBanner } from '../demo/DemoModeBanner';
import { isDemoMode } from '../demo/demoMode';
import { useComposeShortcut } from '../features/feed/useComposeShortcut';
import { useJoinFromInviteLink } from '../matrix/hooks/useJoinFromInviteLink';
import { useOpenRoomFromNotification } from '../matrix/hooks/useOpenRoomFromNotification';
import { useRecoveryStatus } from '../matrix/hooks/useRecoveryStatus';
import { openPostAtom, globalFeedOpenAtom, profileUserIdAtom, selectedRoomIdAtom, selectedSpaceViewAtom } from './state/selection';
import { desktopMemberListHiddenAtom, mobileMemberListOpenAtom } from './state/mobile';

/** Real Discord-shaped three-pane shell, wired to live Matrix data (Phase 1+). */
export function AppShell() {
  const recoveryStatus = useRecoveryStatus();
  const [recoveryResolved, setRecoveryResolved] = useState(false);
  const selectedRoomId = useAtomValue(selectedRoomIdAtom);
  const [mobileMembersOpen, setMobileMembersOpen] = useAtom(mobileMemberListOpenAtom);
  const membersHidden = useAtomValue(desktopMemberListHiddenAtom);
  // The global feed spans every public Space, so there's no one member list that belongs beside it.
  const globalFeedOpen = useAtomValue(globalFeedOpenAtom);
  const spaceView = useAtomValue(selectedSpaceViewAtom);
  const profileOpen = !!useAtomValue(profileUserIdAtom);
  const postOpen = !!useAtomValue(openPostAtom);
  // On a phone the main pane only shows once there's something in it: a room, a Space's Posts,
  // or the global feed. The last two aren't rooms, so a room check alone left them invisible.
  const mainPaneHasContent = !!selectedRoomId || spaceView === 'feed' || globalFeedOpen || profileOpen || postOpen;
  useOpenRoomFromNotification();
  useComposeShortcut();
  const inviteLinkJoin = useJoinFromInviteLink();
  const [inviteErrorDismissed, setInviteErrorDismissed] = useState(false);

  return (
    <div
      className="nu-shell"
      data-nu-role="app-shell"
      // Below the responsive breakpoint (styles/base/shell.css) the shell shows one "screen" at
      // a time instead of all four columns side by side — these two attributes are what the
      // media query switches on. They're no-ops above the breakpoint.
      data-nu-mobile-pane={mainPaneHasContent ? 'chat' : 'sidebar'}
      data-nu-mobile-members-open={mobileMembersOpen}
      data-nu-members-hidden={membersHidden || globalFeedOpen || profileOpen || postOpen}
    >
      <VoiceCallSession>
        <ServerRail />
        <ChannelList />
        <MainPane />
        <MemberList />
      </VoiceCallSession>
      {mobileMembersOpen && (
        <div
          className="nu-shell__mobile-backdrop"
          data-nu-role="mobile-member-list-backdrop"
          onClick={() => setMobileMembersOpen(false)}
        />
      )}
      {isDemoMode() && <DemoModeBanner />}
      <DesktopNotifications />
      <PostNotificationRules />
      {/* Writes power levels and kicks; the demo's sample world has nothing it should change. */}
      {!isDemoMode() && <FeedGovernance />}
      <MentionInboxCollector />
      <ActivityWatcher />
      <MentionInviteAcceptor />
      <SpaceAutoJoiner />
      <IncomingVerificationListener />
      {recoveryStatus === 'needed' && !recoveryResolved && (
        <RecoveryKeyPrompt onResolved={() => setRecoveryResolved(true)} />
      )}
      {inviteLinkJoin.status === 'error' && !inviteErrorDismissed && (
        <div className="nu-invite-link-banner" data-nu-role="invite-link-error">
          Couldn't join from that invite link: {inviteLinkJoin.message}
          <button
            type="button"
            className="nu-invite-link-banner__dismiss"
            onClick={() => setInviteErrorDismissed(true)}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

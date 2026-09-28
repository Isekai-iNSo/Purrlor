import { useRef, useState, type FormEvent } from 'react';
import { ClientEvent, type MatrixClient, type SyncState } from 'matrix-js-sdk';
import { Modal } from '../components/Modal';
import { EmailVerificationModal } from './EmailVerificationModal';
import { initClient, startClient } from '../matrix/client';
import { bootstrapNewAccountEncryption } from '../matrix/e2eeSetup';
import { registerAccount, RegistrationError, type EmailRetry, type EmailVerification, type TermsPolicy } from '../matrix/registration';
import { clearSession } from '../matrix/session';
import { getRuntimeConfig, homeserverDisplayName } from './runtimeConfig';
import './RegisterScreen.css';

type Phase = 'form' | 'creating-account' | 'setting-up-encryption';

async function bootAndSync(session: Parameters<typeof initClient>[0]): Promise<MatrixClient> {
  const mx = await initClient(session);
  await new Promise<void>((resolve) => {
    const onSync = (state: SyncState) => {
      if (state === 'PREPARED') {
        mx.removeListener(ClientEvent.Sync, onSync);
        resolve();
      }
    };
    mx.on(ClientEvent.Sync, onSync);
    void startClient(mx);
  });
  return mx;
}

type RegisterScreenProps = {
  onSwitchToLogin: () => void;
  onRegistered: (mx: MatrixClient, recoveryKey: string) => void;
};

export function RegisterScreen({ onSwitchToLogin, onRegistered }: RegisterScreenProps) {
  const lockedHomeserver = getRuntimeConfig().homeserver;
  const [server, setServer] = useState(lockedHomeserver ?? 'matrix.org');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string>();
  const [pendingTerms, setPendingTerms] = useState<TermsPolicy[] | null>(null);
  const termsResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const [pendingToken, setPendingToken] = useState<{ error?: string } | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const tokenResolverRef = useRef<((token: string | null) => void) | null>(null);
  const [pendingEmailMx, setPendingEmailMx] = useState<MatrixClient | null>(null);
  const [pendingEmailRetry, setPendingEmailRetry] = useState<EmailRetry>();
  const emailResolverRef = useRef<{
    resolve: (result: EmailVerification) => void;
    reject: (err: Error) => void;
  } | null>(null);

  const acceptTerms = (policies: TermsPolicy[]): Promise<boolean> => {
    setPendingTerms(policies);
    return new Promise((resolve) => {
      termsResolverRef.current = resolve;
    });
  };

  const respondToTerms = (accepted: boolean) => {
    setPendingTerms(null);
    termsResolverRef.current?.(accepted);
    termsResolverRef.current = null;
  };

  const verifyEmail = (mx: MatrixClient, retry?: EmailRetry): Promise<EmailVerification> => {
    setPendingEmailRetry(retry);
    setPendingEmailMx(mx);
    return new Promise((resolve, reject) => {
      emailResolverRef.current = { resolve, reject };
    });
  };

  const enterRegistrationToken = (previousError?: string): Promise<string | null> => {
    setPendingToken({ error: previousError });
    setTokenInput('');
    return new Promise((resolve) => {
      tokenResolverRef.current = resolve;
    });
  };

  const respondToToken = (token: string | null) => {
    setPendingToken(null);
    tokenResolverRef.current?.(token);
    tokenResolverRef.current = null;
  };

  const handleEmailVerified = (result: EmailVerification) => {
    setPendingEmailMx(null);
    emailResolverRef.current?.resolve(result);
    emailResolverRef.current = null;
  };

  const handleEmailCancelled = () => {
    setPendingEmailMx(null);
    emailResolverRef.current?.reject(new RegistrationError('Email verification cancelled.'));
    emailResolverRef.current = null;
  };

  const submitting = phase !== 'form';

  const handleSubmit = async (evt: FormEvent) => {
    evt.preventDefault();
    if (submitting) return;

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setError(undefined);
    setPhase('creating-account');
    // registerAccount() persists the new session to localStorage (setSession, in registration.ts)
    // the moment the server actually creates the account — before the two steps below are known
    // to succeed. If either one throws, roll that back: otherwise this screen shows "registration
    // failed, try again" while a real, working (or half-working) session for that account quietly
    // sits in localStorage, ready to confusingly log the user in on their next reload/attempt.
    let registeredButNotBootstrapped = false;
    try {
      const session = await registerAccount(server, username, password, {
        acceptTerms,
        verifyEmail,
        enterRegistrationToken,
      });
      registeredButNotBootstrapped = true;
      const mx = await bootAndSync(session);
      setPhase('setting-up-encryption');
      const recoveryKey = await bootstrapNewAccountEncryption(mx, session.userId, password);
      onRegistered(mx, recoveryKey);
    } catch (err) {
      if (registeredButNotBootstrapped) clearSession();
      setError(err instanceof Error ? err.message : 'Registration failed');
      setPhase('form');
    }
  };

  return (
    <div className="nu-login" data-nu-role="register-screen">
      <form className="nu-login__form" onSubmit={handleSubmit}>
        <h1 className="nu-login__title">Create an account</h1>
        {lockedHomeserver ? (
          <p className="nu-login__server" data-nu-role="register-locked-homeserver">
            On <strong>{homeserverDisplayName(lockedHomeserver)}</strong>
          </p>
        ) : (
          <label className="nu-login__field">
            Homeserver
            <input
              className="nu-login__input"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="matrix.org or https://your-server"
              disabled={submitting}
            />
          </label>
        )}
        <label className="nu-login__field">
          Username
          <input
            className="nu-login__input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            disabled={submitting}
            required
          />
        </label>
        <label className="nu-login__field">
          Password
          <input
            className="nu-login__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
            required
          />
        </label>
        <label className="nu-login__field">
          Confirm password
          <input
            className="nu-login__input"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={submitting}
            required
          />
        </label>
        {error && (
          <p className="nu-login__error" data-nu-role="register-error">
            {error}
          </p>
        )}
        <button className="nu-login__submit" type="submit" disabled={submitting}>
          {phase === 'creating-account' && 'Creating your account…'}
          {phase === 'setting-up-encryption' && 'Setting up encryption…'}
          {phase === 'form' && 'Create account'}
        </button>
        <button type="button" className="nu-login__switch" onClick={onSwitchToLogin} disabled={submitting}>
          Already have an account? Log in
        </button>
      </form>

      {pendingTerms && (
        <Modal title="Terms of Service" onClose={() => respondToTerms(false)}>
          <div className="nu-modal-form">
            <p>This server requires you to accept its terms before you can register:</p>
            <ul className="nu-register__terms-list">
              {pendingTerms.length === 0 ? (
                <li>Terms of service (no details provided by the server)</li>
              ) : (
                pendingTerms.map((policy) => (
                  <li key={policy.url}>
                    <a href={policy.url} target="_blank" rel="noreferrer">
                      {policy.name}
                    </a>
                  </li>
                ))
              )}
            </ul>
            <div className="nu-form-actions">
              <button type="button" className="nu-button nu-button--secondary" onClick={() => respondToTerms(false)}>
                Decline
              </button>
              <button type="button" className="nu-button nu-button--primary" onClick={() => respondToTerms(true)}>
                Accept
              </button>
            </div>
          </div>
        </Modal>
      )}

      {pendingToken && (
        <Modal title="Registration token" onClose={() => respondToToken(null)}>
          <form
            className="nu-modal-form"
            data-nu-role="register-token-form"
            onSubmit={(evt) => {
              evt.preventDefault();
              if (tokenInput.trim()) respondToToken(tokenInput.trim());
            }}
          >
            <p>This server is invite-only. Enter the registration token its admin gave you.</p>
            <label className="nu-login__field">
              Token
              <input
                className="nu-login__input"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                autoComplete="off"
                autoFocus
                required
              />
            </label>
            {pendingToken.error && (
              <p className="nu-login__error" data-nu-role="register-token-error">
                {pendingToken.error}
              </p>
            )}
            <div className="nu-form-actions">
              <button type="button" className="nu-button nu-button--secondary" onClick={() => respondToToken(null)}>
                Cancel
              </button>
              <button type="submit" className="nu-button nu-button--primary">
                Continue
              </button>
            </div>
          </form>
        </Modal>
      )}

      {pendingEmailMx && (
        <EmailVerificationModal
          // A retry is a fresh modal on the same address, so it starts from that state.
          key={pendingEmailRetry ? 'retry' + pendingEmailRetry.previous.sid : 'new'}
          mx={pendingEmailMx}
          retry={pendingEmailRetry}
          onVerified={handleEmailVerified} onCancel={handleEmailCancelled} />
      )}
    </div>
  );
}

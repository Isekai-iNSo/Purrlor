import { useState, type FormEvent } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { Modal } from '../components/Modal';
import type { EmailRetry, EmailVerification } from '../matrix/registration';

function randomClientSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

// Reads as a link inside the sentence, not a third button beside Cancel/Continue.
const linkButtonStyle = { background: 'none', border: 'none', padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit' } as const;

type Step = 'enter-email' | 'sending' | 'awaiting-code' | 'awaiting-link-click' | 'submitting-token';

type EmailVerificationModalProps = {
  mx: MatrixClient;
  /** Set when the server turned down the last attempt (the link wasn't clicked yet): pick up on
   *  that same address rather than asking for it again and sending a second email. */
  retry?: EmailRetry;
  onVerified: (result: EmailVerification) => void;
  onCancel: () => void;
};

/**
 * A homeserver can confirm the address either way: hand back a `submit_url` for an "enter the
 * code from your email" flow, or just email a link with no submit_url at all (validated
 * server-side when clicked — what Continuwuity, the bundled homeserver, does). This handles both
 * rather than assuming one.
 */
export function EmailVerificationModal({ mx, retry, onVerified, onCancel }: EmailVerificationModalProps) {
  const [step, setStep] = useState<Step>(retry ? 'awaiting-link-click' : 'enter-email');
  const [email, setEmail] = useState(retry?.previous.email ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | undefined>(
    retry ? "That address isn't confirmed yet — click the link in the email first, then continue." : undefined
  );
  const [notice, setNotice] = useState<string>();
  const [sid, setSid] = useState<string | undefined>(retry?.previous.sid);
  const [submitUrl, setSubmitUrl] = useState<string>();
  const [clientSecret, setClientSecret] = useState(() => retry?.previous.clientSecret ?? randomClientSecret());
  // The server only sends another email when this goes up; the same number again is a no-op.
  const [sendAttempt, setSendAttempt] = useState(retry ? 2 : 1);

  const sendEmail = async (attempt: number) => {
    const res = await mx.requestRegisterEmailToken(email.trim(), clientSecret, attempt);
    setSid(res.sid);
    setSubmitUrl(res.submit_url);
    setSendAttempt(attempt + 1);
    return res;
  };

  const handleSendEmail = async (evt: FormEvent) => {
    evt.preventDefault();
    if (!email.trim() || step === 'sending') return;
    setStep('sending');
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await sendEmail(sendAttempt);
      setStep(res.submit_url ? 'awaiting-code' : 'awaiting-link-click');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification email');
      setStep('enter-email');
    }
  };

  const handleResend = async () => {
    setError(undefined);
    setNotice(undefined);
    try {
      await sendEmail(sendAttempt);
      setNotice(`Sent another email to ${email.trim()}. It can take a minute — check spam too.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send verification email');
    }
  };

  const handleChangeAddress = () => {
    // A new address is a new verification session on the server.
    setClientSecret(randomClientSecret());
    setSendAttempt(1);
    setSid(undefined);
    setError(undefined);
    setNotice(undefined);
    setStep('enter-email');
  };

  const handleSubmitToken = async (evt: FormEvent) => {
    evt.preventDefault();
    if (!sid || !submitUrl || !token.trim()) return;
    setStep('submitting-token');
    setError(undefined);
    try {
      const res = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid, client_secret: clientSecret, token: token.trim() }),
      });
      const data = (await res.json()) as { success?: boolean };
      if (!res.ok || !data.success) {
        throw new Error("That code wasn't accepted — double-check it and try again.");
      }
      onVerified({ sid, clientSecret, email: email.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
      setStep('awaiting-code');
    }
  };

  return (
    <Modal title="Verify your email" onClose={onCancel}>
      {(step === 'enter-email' || step === 'sending') && (
        <form className="nu-modal-form" onSubmit={handleSendEmail}>
          <p>This server asks new accounts to confirm an email address. We'll send a link to it.</p>
          <label className="nu-field">
            Email address
            <input
              className="nu-field__input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
              disabled={step === 'sending'}
            />
          </label>
          {error && <p className="nu-field__error">{error}</p>}
          <div className="nu-form-actions">
            <button type="button" className="nu-button nu-button--secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="nu-button nu-button--primary" disabled={step === 'sending' || !email.trim()}>
              {step === 'sending' ? 'Sending…' : 'Send verification email'}
            </button>
          </div>
        </form>
      )}

      {(step === 'awaiting-code' || step === 'submitting-token') && (
        <form className="nu-modal-form" onSubmit={handleSubmitToken}>
          <p>
            We sent a code to <strong>{email}</strong>. Enter it below.
          </p>
          <label className="nu-field">
            Verification code
            <input
              className="nu-field__input"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
              required
              disabled={step === 'submitting-token'}
            />
          </label>
          {error && <p className="nu-field__error">{error}</p>}
          <div className="nu-form-actions">
            <button type="button" className="nu-button nu-button--secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className="nu-button nu-button--primary"
              disabled={step === 'submitting-token' || !token.trim()}
            >
              {step === 'submitting-token' ? 'Verifying…' : 'Verify'}
            </button>
          </div>
        </form>
      )}

      {step === 'awaiting-link-click' && (
        <div className="nu-modal-form">
          <p>
            We sent a link to <strong>{email}</strong>. Open the email and click the link (it works for
            an hour), then come back here and continue.
          </p>
          {notice && <p>{notice}</p>}
          {error && <p className="nu-field__error">{error}</p>}
          <p>
            No email?{' '}
            <button type="button" style={linkButtonStyle} onClick={handleResend}>
              Send it again
            </button>{' '}
            or{' '}
            <button type="button" style={linkButtonStyle} onClick={handleChangeAddress}>
              use a different address
            </button>
            .
          </p>
          <div className="nu-form-actions">
            <button type="button" className="nu-button nu-button--secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="nu-button nu-button--primary"
              onClick={() => sid && onVerified({ sid, clientSecret, email: email.trim() })}
            >
              I've clicked the link — continue
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

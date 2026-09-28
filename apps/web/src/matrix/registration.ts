import { AuthType, createClient, MatrixError, type IAuthData, type MatrixClient } from 'matrix-js-sdk';
import { resolveHomeserverBaseUrl } from './login';
import { setSession, type Session } from './session';

export class RegistrationError extends Error {}

export type TermsPolicy = { name: string; url: string; version: string };
export type EmailSession = { sid: string; clientSecret: string };

/** One address, and a verification session per email sent to it, newest first. Each resend is
 *  its own session: Continuwuity gives a session a new token on every resend, which kills the
 *  link in the earlier email, and people click whichever email they open first. Separate
 *  sessions keep every link working; registration tries each until the server takes one. */
export type EmailVerification = { email: string; sessions: EmailSession[] };

/** The server turned down every session sent — almost always because no link in the emails
 *  has been clicked yet. Carries what's needed to pick up where the user left off. */
export type EmailRetry = { previous: EmailVerification; error: string };

/** What the caller needs to resolve mid-registration when the server asks for it. */
export type RegistrationPrompts = {
  acceptTerms: (policies: TermsPolicy[]) => Promise<boolean>;
  /** Given the (still-unauthenticated) registration client, drive an email-verification UI and
   *  resolve once the address has actually been confirmed. `retry` is set when the server
   *  rejected the last one: resume on that same address (no second email) and show why. */
  verifyEmail: (mx: MatrixClient, retry?: EmailRetry) => Promise<EmailVerification>;
  /** Ask for the invite token an invite-only server hands out. `previousError` is the server's
   *  rejection of the last token tried, if any. Resolve null to give up. */
  enterRegistrationToken: (previousError?: string) => Promise<string | null>;
};

const SUPPORTED_STAGES = new Set<string>([
  AuthType.Dummy,
  AuthType.Terms,
  AuthType.Email,
  AuthType.RegistrationToken,
  AuthType.UnstableRegistrationToken,
]);

const isTokenStage = (stage: string) =>
  stage === AuthType.RegistrationToken || stage === AuthType.UnstableRegistrationToken;

function extractTermsPolicies(params: Record<string, Record<string, unknown>> | undefined): TermsPolicy[] {
  const policies = params?.[AuthType.Terms]?.policies as
    | Record<string, Record<string, unknown> & { version: string }>
    | undefined;
  if (!policies) return [];

  return Object.values(policies).flatMap((policy) => {
    const lang = Object.entries(policy).find(([key]) => key !== 'version');
    if (!lang) return [];
    const [, info] = lang as [string, { name: string; url: string }];
    return [{ name: info.name, url: info.url, version: policy.version }];
  });
}

/**
 * Drives Matrix's User-Interactive Auth registration flow. Supports the common stages for a
 * self-hosted homeserver: `m.login.dummy` (nothing further needed), `m.login.terms` (accept a
 * ToS), `m.login.email.identity` (verify an email address — homeserver-native, no separate
 * identity server assumed), and `m.login.registration_token` (an invite token — how the
 * homeserver deploy/setup.sh provisions keeps sign-up invite-only). Deliberately doesn't handle
 * msisdn verification, recaptcha, or SSO — a server requiring one of those for registration
 * would need reconfiguring to drop it for this to work.
 */
export async function registerAccount(
  server: string,
  username: string,
  password: string,
  prompts: RegistrationPrompts
): Promise<Session> {
  const baseUrl = await resolveHomeserverBaseUrl(server);
  const mx = createClient({ baseUrl });

  let sessionId: string | null = null;
  let auth: Record<string, unknown> | undefined;
  let lastEmail: EmailVerification | undefined;
  let emailSessionIndex = 0;

  // Generous: pressing "continue" before clicking the email's link costs a round each time,
  // plus one per extra email sent.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await mx.register(username, password, sessionId, auth as { session?: string; type: string });
      if (!res.access_token || !res.device_id) {
        throw new RegistrationError('Server did not return a session after registration.');
      }
      const session: Session = {
        baseUrl,
        userId: res.user_id,
        deviceId: res.device_id,
        accessToken: res.access_token,
      };
      setSession(session);
      return session;
    } catch (err) {
      if (!(err instanceof MatrixError) || err.httpStatus !== 401) {
        if (err instanceof RegistrationError) throw err;
        throw new RegistrationError(err instanceof Error ? err.message : 'Registration failed.');
      }

      // `error` is the server's reason for rejecting the last attempt (a wrong token, say) —
      // part of the 401 body, just not modelled on IAuthData.
      const uia = err.data as IAuthData & { error?: string };
      sessionId = uia.session ?? sessionId;

      const completed = new Set(uia.completed ?? []);
      const usable = (uia.flows ?? []).filter(
        (f) => f.stages.every((stage) => SUPPORTED_STAGES.has(stage)) && [...completed].every((c) => f.stages.includes(c))
      );
      // A server open to anyone with a verified email address can still offer an invite-code
      // route alongside it (Continuwuity does) — most people have no code, so don't ask for one.
      const flow = usable.find((f) => !f.stages.some(isTokenStage)) ?? usable[0];
      if (!flow) {
        const required = uia.flows?.[0]?.stages.join(', ') ?? 'additional verification';
        throw new RegistrationError(
          `This server requires ${required} to register, which Purrlor doesn't support yet — try adjusting your homeserver's registration settings.`
        );
      }

      const nextStage = flow.stages.find((stage) => !completed.has(stage));
      if (!nextStage) {
        throw new RegistrationError('Registration stalled — the server did not accept a known stage.');
      }

      if (nextStage === AuthType.Terms) {
        const accepted = await prompts.acceptTerms(extractTermsPolicies(uia.params));
        if (!accepted) {
          throw new RegistrationError('You need to accept the terms to create an account.');
        }
        auth = { type: nextStage, session: sessionId ?? undefined };
      } else if (nextStage === AuthType.Email) {
        // Continuwuity (and Synapse) answer an unconfirmed address with this same stage again,
        // plus the reason — so it's the same person on the same address, not a fresh start.
        // Before asking the user again, try the sessions of the other emails they were sent —
        // the link they clicked may be in any of them.
        const rejected = auth?.type === nextStage ? lastEmail : undefined;
        let email: EmailVerification;
        if (rejected && emailSessionIndex + 1 < rejected.sessions.length) {
          email = rejected;
          emailSessionIndex += 1;
        } else {
          const retry = rejected ? { previous: rejected, error: uia.error ?? '' } : undefined;
          email = lastEmail = await prompts.verifyEmail(mx, retry);
          emailSessionIndex = 0;
        }
        const { sid, clientSecret } = email.sessions[emailSessionIndex];
        auth = {
          type: nextStage,
          session: sessionId ?? undefined,
          // Homeserver-native email verification (no delegated identity server) only needs
          // sid + client_secret — matrix-js-sdk's ThreepidCreds type marks id_server/
          // id_access_token as required, but those only apply to the delegated-IS case.
          threepid_creds: { sid, client_secret: clientSecret },
        };
      } else if (isTokenStage(nextStage)) {
        // A wrong token comes back as another 401 for this same stage with `error` set, which
        // lands here again — so re-asking shows the user why, instead of failing the whole form.
        const retrying = auth?.type === nextStage;
        const token = await prompts.enterRegistrationToken(retrying ? uia.error : undefined);
        if (!token) {
          throw new RegistrationError('This server is invite-only — you need a registration token to sign up.');
        }
        auth = { type: nextStage, token, session: sessionId ?? undefined };
      } else {
        auth = { type: nextStage, session: sessionId ?? undefined };
      }
    }
  }

  throw new RegistrationError('Registration did not complete after several attempts.');
}

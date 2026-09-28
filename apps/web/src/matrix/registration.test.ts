import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatrixError } from 'matrix-js-sdk';
import { registerAccount, RegistrationError } from './registration';

const register = vi.fn();

vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: () => ({ register }) };
});
vi.mock('./session', () => ({ setSession: vi.fn() }));

const TOKEN_STAGE = 'm.login.registration_token';

function uiaChallenge(extra: Record<string, unknown> = {}): MatrixError {
  return new MatrixError(
    { session: 'sess1', flows: [{ stages: [TOKEN_STAGE] }], params: {}, ...extra },
    401
  );
}

function prompts(tokens: (string | null)[]) {
  const enterRegistrationToken = vi.fn(async () => tokens.shift() ?? null);
  return {
    acceptTerms: vi.fn(),
    verifyEmail: vi.fn(),
    enterRegistrationToken,
  };
}

describe('registerAccount — registration token stage', () => {
  beforeEach(() => register.mockReset());

  it('sends the token the user entered and completes', async () => {
    register
      .mockRejectedValueOnce(uiaChallenge())
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = prompts(['invite-123']);

    const session = await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(session.userId).toBe('@a:x');
    expect(register).toHaveBeenLastCalledWith('a', 'password1', 'sess1', {
      type: TOKEN_STAGE,
      token: 'invite-123',
      session: 'sess1',
    });
    expect(p.enterRegistrationToken).toHaveBeenCalledWith(undefined);
  });

  it("re-asks with the server's error after a wrong token", async () => {
    register
      .mockRejectedValueOnce(uiaChallenge())
      .mockRejectedValueOnce(uiaChallenge({ errcode: 'M_FORBIDDEN', error: 'Invalid registration token' }))
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = prompts(['wrong', 'right']);

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.enterRegistrationToken).toHaveBeenNthCalledWith(2, 'Invalid registration token');
    expect(register.mock.calls[2][3]).toMatchObject({ token: 'right' });
  });

  it('gives up cleanly when the user cancels the token prompt', async () => {
    register.mockRejectedValueOnce(uiaChallenge());

    await expect(registerAccount('https://hs.example', 'a', 'password1', prompts([null]))).rejects.toBeInstanceOf(
      RegistrationError
    );
    expect(register).toHaveBeenCalledTimes(1);
  });
});

const EMAIL_STAGE = 'm.login.email.identity';

describe('registerAccount — email stage', () => {
  beforeEach(() => register.mockReset());

  const emailChallenge = (extra: Record<string, unknown> = {}) =>
    new MatrixError(
      {
        session: 'sess1',
        flows: [{ stages: [TOKEN_STAGE, EMAIL_STAGE] }],
        completed: [TOKEN_STAGE],
        params: {},
        ...extra,
      },
      401
    );

  it('sends the verified sid/client secret, and resumes the same address when the link was not clicked yet', async () => {
    const first = { sid: 's1', clientSecret: 'c1', email: 'a@example.com' };
    register
      .mockRejectedValueOnce(emailChallenge())
      .mockRejectedValueOnce(
        emailChallenge({ errcode: 'M_THREEPID_AUTH_FAILED', error: 'This email address has not been validated.' })
      )
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = { ...prompts([]), verifyEmail: vi.fn(async () => first) };

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.verifyEmail).toHaveBeenNthCalledWith(1, expect.anything(), undefined);
    expect(p.verifyEmail).toHaveBeenNthCalledWith(2, expect.anything(), {
      previous: first,
      error: 'This email address has not been validated.',
    });
    expect(register.mock.calls[2][3]).toEqual({
      type: EMAIL_STAGE,
      session: 'sess1',
      threepid_creds: { sid: 's1', client_secret: 'c1' },
    });
  });

  it('takes the email-only route over the invite-code one when the server offers both', async () => {
    const creds = { sid: 's1', clientSecret: 'c1', email: 'a@example.com' };
    register
      .mockRejectedValueOnce(
        new MatrixError(
          { session: 'sess1', flows: [{ stages: [TOKEN_STAGE] }, { stages: [EMAIL_STAGE] }], params: {} },
          401
        )
      )
      .mockResolvedValueOnce({ user_id: '@a:x', device_id: 'D', access_token: 'T' });
    const p = { ...prompts([]), verifyEmail: vi.fn(async () => creds) };

    await registerAccount('https://hs.example', 'a', 'password1', p);

    expect(p.enterRegistrationToken).not.toHaveBeenCalled();
    expect(register.mock.calls[1][3]).toMatchObject({ type: EMAIL_STAGE });
  });
});

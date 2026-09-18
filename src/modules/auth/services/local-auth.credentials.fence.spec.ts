import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { LocalAuthService } from './local-auth.service';
import { hashRefreshToken } from '../utils/refresh-token-hash.util';

/**
 * F-006 and F-026 of the September 2026 register.
 *
 * Two different leaks through the same door. A refresh token used to sit in the
 * table in the clear, so a database dump was a week of live sessions for every
 * local account; and every login attempt wrote the address, the stored hash's
 * prefix and whether the password matched into the log, which is the account
 * list plus an oracle for whoever can read it.
 */

type Row = { token: string; userId: string; expiresAt: Date; revoked: boolean };

const USER = {
  id: 'u1',
  email: 'someone@example.test',
  name: 'Someone',
  isAdmin: false,
  // bcrypt hash of 'right-password'
  passwordHash: '$2b$10$utgTRL.0mBpgRhZYzD2wXeOH8x49lBrgQRVT.miQQP/TsER2wBQE.',
};

function build() {
  const rows: Row[] = [];
  const refreshTokenRepo = {
    save: jest.fn(async (row: Row) => {
      rows.push(row);
      return row;
    }),
    findOne: jest.fn(
      async ({ where }: { where: { token: string } }) =>
        rows.find((r) => r.token === where.token) ?? null,
    ),
    update: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };
  const userRepo = {
    findOne: jest.fn(async ({ where }: { where: Record<string, string> }) =>
      where.email === USER.email || where.id === USER.id ? USER : null,
    ),
  };
  const jwtService = { sign: jest.fn(() => 'access-token') };
  const service = new LocalAuthService(
    userRepo as never,
    refreshTokenRepo as never,
    jwtService as never,
  );
  return { service, rows, refreshTokenRepo, userRepo };
}

describe('local authentication — what reaches the database and the log', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map((a) => String(a)).join(' '));
        });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the refresh token', () => {
    it('is stored as a digest, never as the credential itself', async () => {
      const { service, rows } = build();

      const { refresh_token } = await service.login({
        email: USER.email,
        password: 'right-password',
      } as never);

      expect(rows).toHaveLength(1);
      expect(rows[0].token).toBe(hashRefreshToken(refresh_token));
      expect(JSON.stringify(rows)).not.toContain(refresh_token);
    });

    it('is still honoured when the holder presents it', async () => {
      const { service } = build();
      const { refresh_token } = await service.login({
        email: USER.email,
        password: 'right-password',
      } as never);

      await expect(service.refresh(refresh_token)).resolves.toEqual({
        access_token: 'access-token',
      });
    });

    it('is not honoured when the raw row value is presented instead', async () => {
      // The shape a stolen dump would give an attacker: the digest, offered as
      // if it were the token.
      const { service, rows } = build();
      await service.login({
        email: USER.email,
        password: 'right-password',
      } as never);

      await expect(service.refresh(rows[0].token)).rejects.toThrow(
        /Invalid or expired/,
      );
    });

    it('is revoked by digest, so logout still ends the session', async () => {
      const { service, refreshTokenRepo } = build();
      const { refresh_token } = await service.login({
        email: USER.email,
        password: 'right-password',
      } as never);

      await service.logout(refresh_token);

      expect(refreshTokenRepo.update).toHaveBeenCalledWith(
        { token: hashRefreshToken(refresh_token) },
        { revoked: true },
      );
    });
  });

  describe('a login attempt', () => {
    it('says nothing about the address, the stored hash or the verdict', async () => {
      const { service } = build();

      await service.login({
        email: USER.email,
        password: 'right-password',
      } as never);
      await expect(
        service.login({ email: USER.email, password: 'wrong' } as never),
      ).rejects.toThrow();
      await expect(
        service.login({ email: 'nobody@example.test', password: 'x' } as never),
      ).rejects.toThrow();

      const all = logged.join('\n');
      expect(all).not.toContain(USER.email);
      expect(all).not.toContain('nobody@example.test');
      expect(all).not.toContain(USER.passwordHash.slice(0, 7));
      expect(all).not.toMatch(/password valid/i);
    });

    it('does the same work for a missing account as for a wrong password', async () => {
      // Identical wording is only half of it: bcrypt at cost 12 takes a few
      // hundred milliseconds, so skipping the comparison when there is no such
      // account times the difference out loud. Asserted as "the comparison
      // happened" rather than by measuring a clock, which no test should do.
      const { service } = build();
      const compare = jest.spyOn(bcrypt, 'compare');

      await expect(
        service.login({ email: 'nobody@example.test', password: 'x' } as never),
      ).rejects.toThrow();

      expect(compare).toHaveBeenCalledTimes(1);
      expect(compare.mock.calls[0][1]).toMatch(/^\$2b\$12\$/);
    });

    it('answers a missing account and a wrong password identically', async () => {
      const { service } = build();

      const missing = await service
        .login({ email: 'nobody@example.test', password: 'x' } as never)
        .catch((e: Error) => e.message);
      const wrong = await service
        .login({ email: USER.email, password: 'wrong' } as never)
        .catch((e: Error) => e.message);

      expect(missing).toBe(wrong);
    });
  });
});

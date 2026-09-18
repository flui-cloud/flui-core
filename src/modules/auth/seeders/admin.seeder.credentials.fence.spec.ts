jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { Logger } from '@nestjs/common';
import { AdminSeeder } from './admin.seeder';

/**
 * F-007 of the September 2026 register: the generated admin password — the owner
 * credential of the installation — was written to the logger.
 *
 * It bought nothing. No Flui-provisioned installation reaches that branch: the
 * CLI generates `ADMIN_PASSWORD` itself and passes it into the bootstrap script
 * (`cli/src/services/cli-k3s-script.service.ts`), and `flui env credentials`
 * reads it back from the cluster record. The branch is the hand-rolled local
 * run, so the password goes to stdout, where the person who started it is
 * looking, and never through the logger — which in production is a JSON stream
 * into aggregation.
 */

describe('seeding the first administrator', () => {
  let logged: string[];
  let written: string[];
  let saved: Record<string, string | undefined>;

  const config = (vars: Record<string, string>) =>
    ({ get: (name: string) => vars[name] }) as never;

  const seed = async (vars: Record<string, string>) => {
    const users: Array<Record<string, unknown>> = [];
    const seeder = new AdminSeeder(
      config(vars),
      {
        findOne: jest.fn(async () => null),
        save: jest.fn(async (u: Record<string, unknown>) => {
          users.push(u);
          return u;
        }),
      } as never,
      { create: jest.fn((x: unknown) => x), save: jest.fn() } as never,
    );
    await seeder.onModuleInit();
    return users;
  };

  beforeEach(() => {
    logged = [];
    written = [];
    saved = { AUTH_MODE: process.env.AUTH_MODE };
    // The seeder only runs at all in local mode, which is also the only mode
    // that reaches the generated-password branch.
    process.env.AUTH_MODE = 'local';
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map((a) => String(a)).join(' '));
        });
    }
    jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('never logs a password that was given to it', async () => {
    await seed({
      ADMIN_EMAIL: 'admin@example.test',
      ADMIN_PASSWORD: 'a-password-the-operator-chose',
    });

    expect(logged.join('\n')).not.toContain('a-password-the-operator-chose');
    expect(written.join('')).not.toContain('a-password-the-operator-chose');
  });

  it('never logs a password it generated, and shows it once on stdout instead', async () => {
    const users = await seed({ ADMIN_EMAIL: 'admin@example.test' });

    // Whatever it generated, it is not in the log.
    const output = written.join('');
    const shown = /Password: (\S+)/.exec(output)?.[1];
    expect(shown).toBeTruthy();
    expect(logged.join('\n')).not.toContain(shown as string);

    // And it really is the account's password, not a placeholder.
    expect(users).toHaveLength(1);
    expect(String(users[0].passwordHash)).toMatch(/^\$2[aby]\$/);
    expect(String(users[0].passwordHash)).not.toContain(shown as string);
  });
});

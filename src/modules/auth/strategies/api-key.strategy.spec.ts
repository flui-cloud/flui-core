import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { ApiKeyStrategy } from './api-key.strategy';
import { ApiKeyService } from '../services/api-key.service';
import { ApiKeyEntity } from '../entities/api-key.entity';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import { SERVICE_IDENTITY } from '../constants/service-identities';
import { SandboxVisitorEntity } from '../../sandbox/entities/sandbox-visitor.entity';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const GONE_ID = '22222222-2222-4222-8222-222222222222';

type KeyRow = Partial<ApiKeyEntity> & { name: string; userId: string | null };

type VisitorRow = { userId: string; removedAt: Date | null };

function build(
  record: KeyRow | null,
  users: Partial<UserEntity>[] = [],
  opts: { anyRecord?: KeyRow | null; visitors?: VisitorRow[] } = {},
) {
  const apiKeys = {
    findValid: jest.fn().mockResolvedValue(record),
    findAny: jest.fn().mockResolvedValue(opts.anyRecord ?? record),
    touch: jest.fn(),
  } as unknown as ApiKeyService;
  const userRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(users.find((u) => u.id === where.id) ?? null),
    ),
  } as unknown as Repository<UserEntity>;
  const visitors = {
    exists: jest.fn(
      ({ where }: { where: { userId: string; removedAt?: unknown } }) =>
        Promise.resolve(
          (opts.visitors ?? []).some(
            (v) =>
              v.userId === where.userId &&
              (where.removedAt === undefined || v.removedAt !== null),
          ),
        ),
    ),
  } as unknown as Repository<SandboxVisitorEntity>;
  return new ApiKeyStrategy(apiKeys, userRepo, visitors);
}

describe('ApiKeyStrategy', () => {
  describe('a key of a visitor whose visit ended', () => {
    const goneCode = expect.objectContaining({ code: 'VISITOR_GONE' });

    it('says the visit ended for a key revoked when the visitor was removed', async () => {
      const strategy = build(null, [], {
        anyRecord: { name: 'cli', userId: GONE_ID, revoked: true },
        visitors: [{ userId: GONE_ID, removedAt: new Date() }],
      });
      await expect(strategy.validate('flui_x')).rejects.toMatchObject({
        response: goneCode,
      });
    });

    it('says the visit ended when the visitor is gone and its key was never revoked', async () => {
      const strategy = build(
        { name: 'cli', userId: GONE_ID, scopes: null },
        [],
        {
          visitors: [{ userId: GONE_ID, removedAt: null }],
        },
      );
      await expect(strategy.validate('flui_x')).rejects.toMatchObject({
        response: goneCode,
      });
    });

    it('stays a plain refusal for a revoked key of a visitor not removed, or of anybody else', async () => {
      const ofVisitor = build(null, [], {
        anyRecord: { name: 'cli', userId: GONE_ID, revoked: true },
        visitors: [{ userId: GONE_ID, removedAt: null }],
      });
      await expect(ofVisitor.validate('flui_x')).rejects.toThrow(
        'Invalid or revoked API key',
      );
      const unknown = build(null, [], { anyRecord: null });
      await expect(unknown.validate('flui_x')).rejects.toThrow(
        'Invalid or revoked API key',
      );
    });
  });

  it('gives the key exactly the identity of the user it belongs to', async () => {
    const strategy = build({ name: 'laptop', userId: USER_ID, scopes: null }, [
      {
        id: USER_ID,
        email: 'someone@example.com',
        role: IdentityRole.USER,
        isAdmin: false,
      },
    ]);

    await expect(strategy.validate('flui_x')).resolves.toMatchObject({
      userId: USER_ID,
      email: 'someone@example.com',
      isAdmin: false,
    });
  });

  it('refuses a key whose user no longer exists instead of promoting it', async () => {
    const strategy = build({ name: 'laptop', userId: GONE_ID, scopes: null });

    await expect(strategy.validate('flui_x')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a dangling key even when it carries a declared service name', async () => {
    const strategy = build({
      name: SERVICE_IDENTITY.CLI_BOOTSTRAP.keyName,
      userId: GONE_ID,
      scopes: null,
    });

    await expect(strategy.validate('flui_x')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('keeps the seeded bootstrap key working (no userId written yet)', async () => {
    const strategy = build({
      name: SERVICE_IDENTITY.CLI_BOOTSTRAP.keyName,
      userId: null,
      scopes: null,
    });

    await expect(strategy.validate('flui_x')).resolves.toMatchObject({
      userId: SERVICE_IDENTITY.CLI_BOOTSTRAP.id,
    });
  });

  it('keeps the local-mode M2M key working, including the legacy sentinel', async () => {
    const legacy = build({
      name: SERVICE_IDENTITY.CLI_SERVICE_ACCOUNT.keyName,
      userId: 'service-account',
      scopes: null,
    });
    await expect(legacy.validate('flui_x')).resolves.toMatchObject({
      userId: SERVICE_IDENTITY.CLI_SERVICE_ACCOUNT.id,
    });

    const current = build({
      name: SERVICE_IDENTITY.CLI_SERVICE_ACCOUNT.keyName,
      userId: SERVICE_IDENTITY.CLI_SERVICE_ACCOUNT.id,
      scopes: null,
    });
    await expect(current.validate('flui_x')).resolves.toMatchObject({
      userId: SERVICE_IDENTITY.CLI_SERVICE_ACCOUNT.id,
    });
  });

  it('refuses — not 500s — on a key whose userId is not a user id at all', async () => {
    const strategy = build({
      name: 'laptop',
      userId: 'service-account',
      scopes: null,
    });

    await expect(strategy.validate('flui_x')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses an invalid or revoked key', async () => {
    const strategy = build(null);

    await expect(strategy.validate('flui_x')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

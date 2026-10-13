import { NotFoundException } from '@nestjs/common';
import {
  SandboxVisitorTestService,
  VISITOR_KEY_GROUPS,
  visitorTestRouteEnabled,
} from './sandbox-visitor-test.service';
import { SandboxVisitorTestController } from '../sandbox-visitor-test.controller';
import { UserEntity } from '../../auth/entities/user.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';
import { isPlaceholderEmail } from '../../auth/utils/placeholder-email.util';

describe('the test route that makes a demo visitor', () => {
  const ENV = {
    ZITADEL_SERVICE_ACCOUNT_PAT: 'pat',
    OIDC_ISSUER: 'https://auth.example.test',
  };
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, ENV);
  });
  afterEach(() => {
    process.env = saved;
  });

  const build = (failLocal = false) => {
    const rows = new Map<unknown, Array<Record<string, unknown>>>();
    const repo = (entity: unknown) => ({
      create: (r: Record<string, unknown>) => r,
      save: async (
        r: Record<string, unknown> | Array<Record<string, unknown>>,
      ) => {
        if (failLocal && entity === SandboxVisitorEntity) {
          throw new Error('duplicate');
        }
        const list = Array.isArray(r) ? r : [r];
        rows.set(entity, [...(rows.get(entity) ?? []), ...list]);
        return entity === UserEntity ? { ...list[0], id: 'u-visitor' } : r;
      },
    });
    const oidc = {
      createHuman: jest.fn(async () => 'idp-1'),
      deleteUser: jest.fn(async () => undefined),
    };
    const apiKeys = {
      generateApiKey: jest.fn(async () => ({ plaintext: 'flui_visitor' })),
    };
    const dataSource = {
      transaction: async (work: (m: unknown) => Promise<unknown>) =>
        work({ getRepository: repo }),
    };
    const service = new SandboxVisitorTestService(
      oidc as never,
      oidc as never,
      apiKeys as never,
      dataSource as never,
    );
    return { service, oidc, apiKeys, rows };
  };

  it('is off unless switched on', () => {
    expect(visitorTestRouteEnabled({})).toBe(false);
    expect(visitorTestRouteEnabled({ SANDBOX_VISITOR_TEST_ROUTE: '1' })).toBe(
      false,
    );
    expect(
      visitorTestRouteEnabled({ SANDBOX_VISITOR_TEST_ROUTE: 'true' }),
    ).toBe(true);
  });

  it('answers 404 while switched off, and makes nobody', async () => {
    delete process.env.SANDBOX_VISITOR_TEST_ROUTE;
    const { service, oidc } = build();
    await expect(
      new SandboxVisitorTestController(service).create(),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(oidc.createHuman).not.toHaveBeenCalled();
  });

  it('makes a visitor with read-only grants and a reading key', async () => {
    const { service, oidc, apiKeys, rows } = build();
    const created = await service.create();

    const [, , params] = oidc.createHuman.mock.calls[0] as unknown as [
      string,
      string,
      { userName: string; email: string },
    ];
    expect(params.userName).toMatch(/^visitor-[0-9a-f]{8}$/);
    expect(params.email).toBe(`${params.userName}@visitors.invalid`);
    expect(isPlaceholderEmail(params.email)).toBe(true);

    expect(rows.get(UserEntity)).toEqual([
      expect.objectContaining({
        kind: 'visitor',
        oidcSub: 'idp-1',
        isAdmin: false,
      }),
    ]);
    expect(
      rows.get(IamRoleBindingEntity)!.map((b) => [b.role, b.selector]),
    ).toEqual([
      ['sandbox_visitor', { owner: 'u-visitor' }],
      ['showcase_viewer', { tags: ['showcase'] }],
    ]);
    expect(rows.get(SandboxVisitorEntity)).toEqual([
      { userId: 'u-visitor', idpUserId: 'idp-1', ipHash: null },
    ]);

    const scopes = (apiKeys.generateApiKey.mock.calls[0] as unknown[])[3];
    expect(scopes).toEqual([
      'mcp:catalog:read',
      'mcp:app:read',
      'mcp:obs:read',
      'mcp:spec:validate',
    ]);
    expect(created).toEqual({
      userId: 'u-visitor',
      idpUserId: 'idp-1',
      username: params.userName,
      apiKey: 'flui_visitor',
      groups: VISITOR_KEY_GROUPS,
    });
  });

  it('removes the identity-provider account when the local rows fail', async () => {
    const { service, oidc, apiKeys } = build(true);
    await expect(service.create()).rejects.toThrow('duplicate');
    expect(oidc.deleteUser).toHaveBeenCalledWith(
      'pat',
      'auth.example.test',
      'idp-1',
    );
    expect(apiKeys.generateApiKey).not.toHaveBeenCalled();
  });
});

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { AuthzController } from './authz.controller';
import { InternalAppAuthzService } from '../services/internal-app-authz.service';
import { ApplicationExposure } from '../../applications/enums/application-exposure.enum';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

describe('forwardAuth in front of an internal app', () => {
  const app = {
    id: 'app-1',
    slug: 'grafana',
    clusterId: 'c1',
    exposure: ApplicationExposure.INTERNAL,
  };

  const make = (opts: { mayRead: boolean; withheld?: string[] }) => {
    const repo = { findBySlug: jest.fn(async () => app) };
    const access = { can: jest.fn(async () => opts.mayRead) };
    const policy = {
      check: jest.fn(
        async (_p: unknown, action: string) =>
          !(opts.withheld ?? []).includes(action),
      ),
    };
    const service = Reflect.construct(InternalAppAuthzService, [
      repo,
      access,
      policy,
    ]) as InternalAppAuthzService;
    const audit = { emit: jest.fn() };
    const controller = new AuthzController(
      service,
      {} as never,
      audit as never,
      {} as never,
    );
    return { controller, audit, access, policy };
  };

  const call = (controller: AuthzController, isAdmin = false) =>
    controller.internalApp(
      {
        user: { userId: 'u1', email: 'u1@x', roles: {}, isAdmin } as never,
        headers: { 'x-forwarded-host': 'grafana.internal.example.com' },
      },
      { setHeader: jest.fn() } as never,
      '10.0.0.1',
    );

  it('lets through a person who may read the app and its data', async () => {
    const { controller, audit, access } = make({ mayRead: true });

    await call(controller);

    expect(access.can).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      IAM_PERMISSION.APP_READ,
      app,
    );
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'allow', appId: 'app-1' }),
    );
  });

  it('refuses a person with no read on this app', async () => {
    const { controller, audit } = make({ mayRead: false });

    await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'deny', reason: 'not_permitted' }),
    );
  });

  it('refuses a person who reads the app but lacks data:access', async () => {
    const { controller, audit } = make({
      mayRead: true,
      withheld: [IAM_PERMISSION.DATA_ACCESS],
    });

    await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'deny', reason: 'not_permitted' }),
    );
  });

  it('refuses an agent key whose scopes do not carry data:access', async () => {
    const { controller, audit } = make({ mayRead: true });

    await expect(
      controller.internalApp(
        {
          user: {
            userId: 'u1',
            roles: {},
            isAdmin: true,
            scopes: ['mcp:mail:read'],
          } as never,
          headers: { 'x-forwarded-host': 'grafana.internal.example.com' },
        },
        { setHeader: jest.fn() } as never,
        '10.0.0.1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'deny', reason: 'not_permitted' }),
    );
  });

  it('still says not_internal for an app that is not internal', async () => {
    const { controller, audit } = make({ mayRead: true });
    app.exposure = ApplicationExposure.PUBLIC;
    try {
      await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      app.exposure = ApplicationExposure.INTERNAL;
    }
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'not_internal' }),
    );
  });
});

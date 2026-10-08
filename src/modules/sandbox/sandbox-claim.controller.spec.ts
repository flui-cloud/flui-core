import { Request } from 'express';
import { NotFoundException } from '@nestjs/common';
import { SandboxClaimController } from './sandbox-claim.controller';
import { loginUrl } from './sandbox-entry';
import { loadSandboxConfig } from './sandbox.config';
import { SandboxTenantEntity } from './entities/sandbox-tenant.entity';
import { SANDBOX_GUEST_REQUEST } from './guards/sandbox-fence.guard';

describe('the login URL a guest is handed', () => {
  it('assumes https for a bare hostname, which is what production passes', () => {
    expect(loginUrl('try.flui.cloud')).toBe('https://try.flui.cloud');
    expect(loginUrl('app.tidy-marmot.109-123-252-6.nip.io')).toBe(
      'https://app.tidy-marmot.109-123-252-6.nip.io',
    );
  });

  it('leaves a value that already carries a scheme alone', () => {
    expect(loginUrl('http://localhost:4200')).toBe('http://localhost:4200');
    expect(loginUrl('https://try.flui.cloud')).toBe('https://try.flui.cloud');
  });
});

describe('the area a guest holds', () => {
  const touched = jest.fn(async () => undefined);
  const build = (held: Partial<SandboxTenantEntity> | null) =>
    new SandboxClaimController(
      { findActiveForUser: async () => held } as never,
      { origin: 'https://demo.flui.cloud' } as never,
      loadSandboxConfig({ SANDBOX_TTL_HOURS: '72' }),
      { touch: touched } as never,
    );
  const req = (userId?: string, guest = true) =>
    ({
      user: userId ? { userId } : undefined,
      ...(guest ? { [SANDBOX_GUEST_REQUEST]: { level: 'full' } } : {}),
    }) as unknown as Request;

  it('says how long is left of it', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const session = await build({ expiresAt }).session(req('u1'));

    expect(session.hasArea).toBe(true);
    expect(session.expiresAt).toBe(expiresAt.toISOString());
    expect(session.secondsRemaining).toBeGreaterThan(3500);
    expect(session.ttlHours).toBe(72);
    expect(session.loginUrl).toBe('https://demo.flui.cloud');
  });

  it('tells a guest who has only looked around that they hold no area yet', async () => {
    const session = await build(null).session(req('u1'));

    expect(session.hasArea).toBe(false);
    expect(session.expiresAt).toBeNull();
    expect(session.secondsRemaining).toBe(0);
  });

  it('answers 404 to anyone who is not a demo guest', async () => {
    await expect(
      build({ expiresAt: new Date() }).session(req('u1', false)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never exposes the namespace of the area', async () => {
    const session = await build({
      expiresAt: new Date(),
      namespace: 'p-area-1234',
    }).session(req('u1'));

    expect(JSON.stringify(session)).not.toContain('p-area-1234');
  });
});

describe("keeping a guest's applications", () => {
  it('counts as an action of the guest and answers with the area', async () => {
    const touch = jest.fn(async () => undefined);
    const controller = new SandboxClaimController(
      {
        findActiveForUser: async () => ({
          expiresAt: new Date(Date.now() + 1000),
        }),
      } as never,
      { origin: 'https://demo.flui.cloud' } as never,
      loadSandboxConfig({}),
      { touch } as never,
    );
    const req = {
      user: { userId: 'u1' },
      [SANDBOX_GUEST_REQUEST]: { userId: 'u1' },
    } as unknown as Request;

    const session = await controller.keep(req);

    expect(touch).toHaveBeenCalledWith('u1');
    expect(session.hasArea).toBe(true);
  });
});

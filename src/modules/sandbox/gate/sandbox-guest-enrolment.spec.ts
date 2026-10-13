import { SandboxGuestEnrolmentService } from './sandbox-guest-enrolment';
import { loadSandboxConfig } from '../sandbox.config';

describe('SandboxGuestEnrolmentService', () => {
  const build = (
    existing: Array<{ principalType: string; principalRef: string }>,
    enabled = true,
  ) => {
    const saved: Array<Record<string, unknown>> = [];
    const bindings = {
      exists: async ({
        where,
      }: {
        where: { principalType: string; principalRef: string };
      }) =>
        existing.some(
          (b) =>
            b.principalType === where.principalType &&
            b.principalRef === where.principalRef,
        ),
      create: (b: Record<string, unknown>) => b,
      save: async (rows: Array<Record<string, unknown>>) => {
        saved.push(...rows);
        return rows;
      },
    };
    const visitors = { findOne: jest.fn().mockResolvedValue(null) };
    const loginClients = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new SandboxGuestEnrolmentService(
      bindings as never,
      loadSandboxConfig(enabled ? { SANDBOX_ENABLED: 'true' } : {}),
      visitors as never,
      loginClients as never,
    );
    return { service, saved, bindings, visitors, loginClients };
  };

  const person = {
    userId: 'u1',
    email: 'mario@example.com',
    hasProviderRoles: false,
  };

  it('leaves a visitor with the roles it was made with', async () => {
    const { service, saved } = build([]);

    expect(await service.enrol({ ...person, kind: 'visitor' })).toBe(false);
    expect(saved).toEqual([]);
  });

  it('makes a new person on a demo instance a guest, fenced to what they own, by id', async () => {
    const { service, saved } = build([]);

    expect(await service.enrol(person)).toBe(true);
    expect(saved).toEqual([
      expect.objectContaining({
        principalRef: 'u1',
        role: 'sandbox',
        selector: { owner: 'u1' },
      }),
      expect.objectContaining({ principalRef: 'u1', role: 'showcase_viewer' }),
    ]);
  });

  it('does nothing on an installation that is not a demo', async () => {
    const { service, saved } = build([], false);

    expect(await service.enrol(person)).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('leaves alone a person the operator invited by address', async () => {
    const { service, saved } = build([
      { principalType: 'user', principalRef: 'mario@example.com' },
    ]);

    expect(await service.enrol(person)).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('leaves alone a person the identity provider already gave a role', async () => {
    const { service } = build([]);

    expect(await service.enrol({ ...person, hasProviderRoles: true })).toBe(
      false,
    );
  });

  it('never enrols the same person twice', async () => {
    const { service, saved } = build([
      { principalType: 'user', principalRef: 'u1' },
    ]);

    expect(await service.enrol(person)).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('enrols inside the caller’s transaction when given one', async () => {
    const { service, saved } = build([]);
    const inTx: Array<Record<string, unknown>> = [];
    const manager = {
      getRepository: () => ({
        exists: async () => false,
        create: (b: Record<string, unknown>) => b,
        save: async (rows: Array<Record<string, unknown>>) => {
          inTx.push(...rows);
          return rows;
        },
      }),
    };

    expect(await service.enrol(person, manager as never)).toBe(true);
    expect(inTx).toHaveLength(2);
    expect(saved).toHaveLength(0);
  });

  it('knows a visitor merged into another account by its identity', async () => {
    const { service, visitors } = build([]);
    visitors.findOne.mockResolvedValueOnce({ linkedUserId: 'r-1' });

    expect(await service.isRetiredVisitor('idp-1')).toBe('merged');
    expect(visitors.findOne).toHaveBeenCalledWith({
      where: { idpUserId: 'idp-1' },
      order: { createdAt: 'DESC' },
    });
  });

  it('knows a visitor removed after it left', async () => {
    const { service, visitors } = build([]);
    visitors.findOne.mockResolvedValueOnce({
      linkedUserId: null,
      removedAt: new Date(),
    });
    expect(await service.isRetiredVisitor('idp-2')).toBe('removed');
  });

  it('treats any visitor row whose person is gone as removed, even before it was marked', async () => {
    const { service, visitors } = build([]);
    visitors.findOne.mockResolvedValueOnce({
      linkedUserId: null,
      removedAt: null,
      upgradedAt: null,
    });
    expect(await service.isRetiredVisitor('idp-4')).toBe('removed');
  });

  it('knows nothing of anybody else', async () => {
    const { service, visitors } = build([]);
    visitors.findOne.mockResolvedValueOnce(null);
    expect(await service.isRetiredVisitor('idp-3')).toBeNull();
  });

  describe('isTryClient', () => {
    const KEYS = ['OIDC_VISITOR_CLIENT_ID', 'OIDC_VISITOR_CLI_CLIENT_ID'];
    const saved = KEYS.map((k) => process.env[k]);
    beforeEach(() => KEYS.forEach((k) => delete process.env[k]));
    afterAll(() =>
      KEYS.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      }),
    );

    it('knows the try applications from the stored row once the entrance is shut', async () => {
      const { service, loginClients } = build([]);
      loginClients.findOne.mockResolvedValue({
        webClientId: 'try-web',
        cliClientId: 'try-cli',
      });
      expect(await service.isTryClient('try-web')).toBe(true);
      expect(await service.isTryClient('try-cli')).toBe(true);
      expect(await service.isTryClient('flui-web')).toBe(false);
      expect(await service.isTryClient(null)).toBe(false);
    });

    it('answers from the environment without reading the row', async () => {
      const { service, loginClients } = build([]);
      process.env.OIDC_VISITOR_CLIENT_ID = 'try-web';
      expect(await service.isTryClient('try-web')).toBe(true);
      expect(loginClients.findOne).not.toHaveBeenCalled();
    });

    it('knows none before the entrance was ever prepared', async () => {
      const { service } = build([]);
      expect(await service.isTryClient('try-web')).toBe(false);
    });
  });
});

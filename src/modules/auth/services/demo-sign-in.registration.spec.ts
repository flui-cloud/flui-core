import { Logger } from '@nestjs/common';
import {
  REGISTRATION_RECORD_KEY,
  closingChanges,
  parseRegistrationRecord,
} from './demo-sign-in.registration';
import { DemoSignInService } from './demo-sign-in.service';

type Policy = {
  isDefault: boolean;
  allowRegister: boolean;
  allowExternalIdp: boolean;
  idpIds: string[];
};

const provider = (policy: Policy) => {
  const metadata = new Map<string, string>();
  const writes: Array<Record<string, boolean>> = [];
  return {
    metadata,
    writes,
    client: {
      getLoginPolicy: async () => ({
        ...policy,
        idpIds: [...policy.idpIds],
        settings: {},
      }),
      openSelfRegistration: async () => {
        policy.isDefault = false;
        policy.allowRegister = true;
        policy.allowExternalIdp = true;
      },
      writeLoginPolicy: async (
        _p: string,
        _h: string,
        _c: unknown,
        changes: Record<string, boolean>,
      ) => {
        writes.push(changes);
        Object.assign(policy, changes);
      },
      deleteIdentityProvider: jest.fn(),
      removeIdentityProviderFromLogin: jest.fn(),
      listIdentityProviders: async () => [],
      findOrgMetadata: async (_p: string, _h: string, key: string) =>
        metadata.get(key) ?? null,
      setOrgMetadata: async (
        _p: string,
        _h: string,
        key: string,
        value: string,
      ) => {
        metadata.set(key, value);
      },
    },
  };
};

const lockSource = () => ({
  createQueryRunner: () => ({
    connect: async () => undefined,
    release: async () => undefined,
    query: async () => [],
  }),
});

const ENV = {
  ZITADEL_SERVICE_ACCOUNT_PAT: 'pat',
  OIDC_ISSUER: 'https://auth.demo.flui.cloud',
};

const closed = (): Policy => ({
  isDefault: true,
  allowRegister: false,
  allowExternalIdp: false,
  idpIds: [],
});

const policyOf = (p: Partial<Policy>) => ({
  ...closed(),
  isDefault: false,
  settings: {},
  ...p,
});

const record = {
  openedAt: '2026-10-01T00:00:00.000Z',
  allowRegisterBefore: false,
  allowExternalIdpBefore: false,
  closedAt: null,
};

describe('demo self-registration', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('remembers the settings it found before opening self-registration', async () => {
    const idp = provider(closed());
    const service = new DemoSignInService(
      idp.client as never,
      lockSource() as never,
    );
    await service.apply(ENV);
    expect(
      parseRegistrationRecord(idp.metadata.get(REGISTRATION_RECORD_KEY)!),
    ).toEqual({ ...record, openedAt: expect.any(String) });
  });

  it('records nothing when self-registration was already open', async () => {
    const idp = provider({
      isDefault: false,
      allowRegister: true,
      allowExternalIdp: true,
      idpIds: [],
    });
    const service = new DemoSignInService(
      idp.client as never,
      lockSource() as never,
    );
    await service.apply(ENV);
    expect(idp.metadata.has(REGISTRATION_RECORD_KEY)).toBe(false);
  });

  it('closes what it opened once the demo is off, keeps the providers, and only once', async () => {
    const idp = provider(closed());
    const service = new DemoSignInService(
      idp.client as never,
      lockSource() as never,
    );
    await service.apply(ENV);

    await expect(service.close(ENV)).resolves.toEqual([
      'allowRegister',
      'allowExternalIdp',
    ]);
    expect(idp.writes).toEqual([
      { allowRegister: false, allowExternalIdp: false },
    ]);
    expect(idp.client.deleteIdentityProvider).not.toHaveBeenCalled();
    expect(idp.client.removeIdentityProviderFromLogin).not.toHaveBeenCalled();

    await expect(service.close(ENV)).resolves.toEqual([]);
    expect(idp.writes).toHaveLength(1);
  });

  it('opens again, and records again, when the demo comes back', async () => {
    const idp = provider(closed());
    const service = new DemoSignInService(
      idp.client as never,
      lockSource() as never,
    );
    await service.apply(ENV);
    await service.close(ENV);
    await service.apply(ENV);
    expect(
      parseRegistrationRecord(idp.metadata.get(REGISTRATION_RECORD_KEY)!)
        ?.closedAt,
    ).toBeNull();
    await expect(service.close(ENV)).resolves.toEqual([
      'allowRegister',
      'allowExternalIdp',
    ]);
  });

  it('never touches a registration Flui did not open', async () => {
    const idp = provider({
      isDefault: false,
      allowRegister: true,
      allowExternalIdp: true,
      idpIds: [],
    });
    const service = new DemoSignInService(
      idp.client as never,
      lockSource() as never,
    );
    await expect(service.close(ENV)).resolves.toEqual([]);
    expect(idp.writes).toEqual([]);
  });

  it('closes on start when the demo is switched off', async () => {
    const idp = provider(closed());
    const service = new DemoSignInService(
      idp.client as never,
      lockSource() as never,
    );
    await service.apply(ENV);
    const close = jest.spyOn(service, 'close');
    const before = process.env.SANDBOX_ENABLED;
    delete process.env.SANDBOX_ENABLED;
    try {
      service.onApplicationBootstrap();
    } finally {
      if (before !== undefined) process.env.SANDBOX_ENABLED = before;
    }
    expect(close).toHaveBeenCalled();
  });

  describe('what to turn back off', () => {
    it('only a setting that was off before and is still on', () => {
      expect(
        closingChanges(
          { ...record, allowExternalIdpBefore: true },
          policyOf({ allowRegister: true, allowExternalIdp: true }),
        ),
      ).toEqual({ allowRegister: false });
    });

    it('nothing an operator already closed, or reset to the instance default', () => {
      expect(closingChanges(record, policyOf({}))).toEqual({});
      expect(
        closingChanges(
          record,
          policyOf({ isDefault: true, allowRegister: true }),
        ),
      ).toEqual({});
    });

    it('nothing without an open record', () => {
      expect(closingChanges(null, policyOf({ allowRegister: true }))).toBe(
        null,
      );
      expect(
        closingChanges(
          { ...record, closedAt: '2026-10-02T00:00:00.000Z' },
          policyOf({ allowRegister: true }),
        ),
      ).toBe(null);
    });

    it('reads a damaged record as none', () => {
      expect(parseRegistrationRecord('{')).toBeNull();
      expect(parseRegistrationRecord('{"closedAt":null}')).toBeNull();
    });
  });
});

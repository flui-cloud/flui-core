import { DemoSignInService } from './demo-sign-in.service';

const fakeProvider = (policy: {
  isDefault: boolean;
  allowRegister: boolean;
  allowExternalIdp: boolean;
  idpIds: string[];
}) => {
  const idps: Array<{ id: string; name: string; type: string }> = [];
  const calls: string[] = [];
  return {
    calls,
    client: {
      getLoginPolicy: async () => ({ ...policy, idpIds: [...policy.idpIds] }),
      openSelfRegistration: async (
        _p: string,
        _h: string,
        current: { isDefault: boolean },
      ) => {
        calls.push(current.isDefault ? 'create-policy' : 'update-policy');
        policy.isDefault = false;
        policy.allowRegister = true;
        policy.allowExternalIdp = true;
      },
      listIdentityProviders: async () => [...idps],
      addSocialIdentityProvider: async (
        _p: string,
        _h: string,
        kind: string,
        params: { name: string },
      ) => {
        const id = `${kind}-id`;
        idps.push({ id, name: params.name, type: kind });
        calls.push(`add-${kind}`);
        return id;
      },
      addIdentityProviderToLogin: async (
        _p: string,
        _h: string,
        id: string,
      ) => {
        policy.idpIds.push(id);
        calls.push(`link-${id}`);
      },
    },
  };
};

const ENV = {
  ZITADEL_SERVICE_ACCOUNT_PAT: 'pat',
  OIDC_ISSUER: 'https://auth.demo.flui.cloud',
};

describe('DemoSignInService', () => {
  it('opens self-registration on the instance default and adds the providers it has keys for', async () => {
    const zitadel = fakeProvider({
      isDefault: true,
      allowRegister: false,
      allowExternalIdp: false,
      idpIds: [],
    });
    const service = new DemoSignInService(zitadel.client as never);

    const added = await service.apply({
      ...ENV,
      SANDBOX_GITHUB_CLIENT_ID: 'gh-id',
      SANDBOX_GITHUB_CLIENT_SECRET: 'gh-secret',
    });

    expect(added).toEqual(['GitHub']);
    expect(zitadel.calls).toEqual([
      'create-policy',
      'add-github',
      'link-github-id',
    ]);
  });

  it('changes nothing the second time', async () => {
    const zitadel = fakeProvider({
      isDefault: true,
      allowRegister: false,
      allowExternalIdp: false,
      idpIds: [],
    });
    const service = new DemoSignInService(zitadel.client as never);
    const env = {
      ...ENV,
      SANDBOX_GOOGLE_CLIENT_ID: 'g-id',
      SANDBOX_GOOGLE_CLIENT_SECRET: 'g-secret',
    };

    await service.apply(env);
    zitadel.calls.length = 0;
    await service.apply(env);

    expect(zitadel.calls).toEqual([]);
  });

  it('opens email registration even with no external provider configured', async () => {
    const zitadel = fakeProvider({
      isDefault: false,
      allowRegister: false,
      allowExternalIdp: true,
      idpIds: [],
    });
    const service = new DemoSignInService(zitadel.client as never);

    expect(await service.apply(ENV)).toEqual([]);
    expect(zitadel.calls).toEqual(['update-policy']);
  });

  it('does nothing when the identity provider cannot be reached from here', async () => {
    const zitadel = fakeProvider({
      isDefault: true,
      allowRegister: false,
      allowExternalIdp: false,
      idpIds: [],
    });
    const service = new DemoSignInService(zitadel.client as never);

    expect(await service.apply({})).toEqual([]);
    expect(zitadel.calls).toEqual([]);
  });
});

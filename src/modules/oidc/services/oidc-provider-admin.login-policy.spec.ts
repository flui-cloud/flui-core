jest.mock('@kubernetes/client-node', () => ({}));

import { of } from 'rxjs';
import {
  OidcProviderAdminClient,
  policySettings,
} from './oidc-provider-admin.service';

describe('opening self-registration', () => {
  const stored = {
    details: { sequence: '3' },
    isDefault: false,
    allowUsernamePassword: true,
    allowRegister: false,
    allowExternalIdp: true,
    passwordCheckLifetime: '864000s',
    externalLoginCheckLifetime: '864000s',
    mfaInitSkipLifetime: '2592000s',
    secondFactorCheckLifetime: '64800s',
    multiFactorCheckLifetime: '43200s',
    passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
    allowDomainDiscovery: true,
    idps: [{ idpId: 'gh' }],
  };

  const build = () => {
    const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
    const http = {
      get: jest.fn(() => of({ data: { policy: stored } })),
      put: jest.fn((_u: string, body: Record<string, unknown>) => {
        sent.push({ method: 'put', body });
        return of({ data: {} });
      }),
      post: jest.fn((_u: string, body: Record<string, unknown>) => {
        sent.push({ method: 'post', body });
        return of({ data: {} });
      }),
    };
    const service = new OidcProviderAdminClient(http as never);
    return { service, sent };
  };

  it('keeps every other setting, so a password check never expires at once', async () => {
    const { service, sent } = build();
    const policy = await service.getLoginPolicy('pat', 'auth.example');

    await service.openSelfRegistration('pat', 'auth.example', policy);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('put');
    expect(sent[0].body).toMatchObject({
      allowRegister: true,
      passwordCheckLifetime: '864000s',
      mfaInitSkipLifetime: '2592000s',
      passwordlessType: 'PASSWORDLESS_TYPE_ALLOWED',
      allowDomainDiscovery: true,
    });
    expect(sent[0].body).not.toHaveProperty('details');
    expect(sent[0].body).not.toHaveProperty('idps');
  });

  it('sends back only what can be written', () => {
    expect(Object.keys(policySettings(stored))).not.toEqual(
      expect.arrayContaining(['details', 'isDefault', 'idps']),
    );
  });
});

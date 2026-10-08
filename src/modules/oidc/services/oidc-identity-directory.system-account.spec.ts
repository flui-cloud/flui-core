jest.mock('@kubernetes/client-node', () => ({}));

import { isSystemAccount } from './oidc-identity-directory.service';

describe('isSystemAccount', () => {
  it('counts every machine user, whatever its name', () => {
    expect(
      isSystemAccount({ userName: 'flui-api-system', isMachine: true }),
    ).toBe(true);
    expect(isSystemAccount({ userName: 'agent-ci', isMachine: true })).toBe(
      true,
    );
  });

  it('counts the bootstrap admin, and no person', () => {
    expect(isSystemAccount({ userName: 'flui-admin@zitadel.example' })).toBe(
      true,
    );
    expect(
      isSystemAccount({ userName: 'mario@example.com', isMachine: false }),
    ).toBe(false);
  });
});

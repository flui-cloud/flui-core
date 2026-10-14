import { overviewLines, securityInDashboard } from './account-view';

const view = {
  profile: {
    userName: 'ada',
    email: 'ada@example.com',
    emailVerified: false,
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: null,
  },
  security: {
    password: false,
    totp: true,
    passkeys: [{ id: 'p-1', name: 'Mac', ready: true }],
    securityKeys: [],
    links: [
      {
        idpId: 'idp-gh',
        provider: 'GitHub',
        externalUserId: 'gh-1',
        externalUserName: 'ada',
      },
    ],
  },
  limits: { guest: true, canUnlink: false },
};

describe('account view', () => {
  it('shows the profile, what signs in and the ids the remove commands take', () => {
    const text = overviewLines(view).join('\n');
    expect(text).toContain('Name          Ada Lovelace');
    expect(text).toContain('(not verified)');
    expect(text).toContain('none (you sign in with a linked account)');
    expect(text).toContain('Authenticator on');
    expect(text).toContain('p-1  Mac');
    expect(text).toContain('GitHub (ada)  idp-gh gh-1');
    expect(text).toContain('stays linked');
  });

  it('sends a security change to the dashboard, naming why', () => {
    const text = securityInDashboard('your password');
    expect(text).toContain('Changes to your password');
    expect(text).toContain('Account page of the dashboard');
    expect(text).toContain('API key');
  });
});

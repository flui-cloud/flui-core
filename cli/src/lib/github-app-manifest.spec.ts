jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});
jest.mock('ora', () => ({ __esModule: true, default: () => ({}) }));
jest.mock('inquirer', () => ({ __esModule: true, default: {} }));

import IntegrationSetup from '../commands/integration/setup';
import IntegrationInstallations from '../commands/integration/installations';
import { manifestStartBody, organizationError } from './github-app-manifest';

const base = {
  name: 'flui-acme',
  webhooksEnabled: false,
  publicApp: true,
  publicApiUrl: 'https://flui.acme.test',
};

describe('creating the GitHub App under an organisation from the CLI', () => {
  it('offers --organization on `flui integration setup github`', () => {
    const flag = (IntegrationSetup as any).flags.organization;
    expect(flag).toBeDefined();
    expect(flag.type).toBe('option');
  });

  it('sends the organisation to the API, trimmed', () => {
    expect(manifestStartBody({ ...base, organization: ' acme ' })).toEqual({
      ...base,
      organization: 'acme',
    });
  });

  it('sends no organisation field when none was given', () => {
    expect(manifestStartBody(base)).toEqual(base);
    expect(
      'organization' in manifestStartBody({ ...base, organization: '' }),
    ).toBe(false);
  });

  it('accepts a GitHub login and refuses what could reshape the URL', () => {
    expect(organizationError(undefined)).toBeNull();
    expect(organizationError('acme-labs')).toBeNull();
    expect(organizationError('acme/../settings')).toContain('not a GitHub');
    expect(organizationError('-acme')).toContain('not a GitHub');
    expect(organizationError('a'.repeat(40))).toContain('not a GitHub');
  });
});

describe('listing your own installations from the CLI', () => {
  it('offers --mine on `flui integration installations`', () => {
    const flag = (IntegrationInstallations as any).flags.mine;
    expect(flag).toBeDefined();
    expect(flag.type).toBe('boolean');
    expect(flag.default).toBe(false);
  });
});

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { CredentialsStatusService } from './credentials-status.service';
import { markCredentialsChanged } from '../credentials-version';
import { CredentialStatus } from '../../repositories/dto/ghcr-pat.dto';

describe('CredentialsStatusService', () => {
  const make = (opts: { token?: boolean; ghcr?: CredentialStatus } = {}) => {
    const tokens = {
      findOne: jest.fn(async () => (opts.token ? { id: 't' } : null)),
    };
    const service = new CredentialsStatusService(
      {
        getGhcrPatStatus: jest.fn(async () => ({
          status: opts.ghcr ?? CredentialStatus.VALID,
        })),
      } as any,
      { getUserProviderConfigurations: jest.fn(async () => []) } as any,
      { isConfigured: jest.fn(async () => true) } as any,
      tokens as any,
    );
    return { service, tokens };
  };

  it('answers from a cache kept per person', async () => {
    const { service, tokens } = make();
    await service.getStatus('a');
    await service.getStatus('b');
    await service.getStatus('a');
    await service.getStatus('b');
    expect(tokens.findOne).toHaveBeenCalledTimes(2);
  });

  it('reads again as soon as a credential was saved anywhere', async () => {
    const { service, tokens } = make();
    await service.getStatus('a');
    markCredentialsChanged();
    await service.getStatus('a');
    expect(tokens.findOne).toHaveBeenCalledTimes(2);
  });

  it('treats an unknown expiry as information, not as a problem', async () => {
    const { service } = make({
      token: true,
      ghcr: CredentialStatus.UNKNOWN_EXPIRY,
    });
    const status = await service.getStatus('a');
    expect(status.overallStatus).toBe(CredentialStatus.VALID);
  });

  it('names the account, not the app, once the installation has its GitHub App', async () => {
    const { service } = make();
    const status = await service.getStatus('a');
    expect(status.items[0]).toMatchObject({
      label: 'Your GitHub account',
      status: CredentialStatus.MISSING,
    });
  });
});

jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import { CredentialsStatusService } from './credentials-status.service';
import { markCredentialsChanged } from '../credentials-version';
import {
  CredentialKind,
  CredentialStatus,
} from '../../repositories/dto/ghcr-pat.dto';
import { GitHubAuthMethod } from '../../repositories/enums/github-auth-method.enum';

describe('CredentialsStatusService', () => {
  const make = (
    opts: {
      token?: boolean;
      ghcr?: CredentialStatus;
      mode?: GitHubAuthMethod | null;
      registry?: boolean;
    } = {},
  ) => {
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
      {
        getConfig: jest.fn(async () =>
          opts.mode === null
            ? null
            : { authMethod: opts.mode ?? GitHubAuthMethod.GITHUB_APP },
        ),
      } as any,
      tokens as any,
      { host: () => (opts.registry ? 'api.example.test' : null) } as any,
    );
    return { service, tokens };
  };

  it('asks for no GHCR token on an instance that runs its own registry', async () => {
    const withRegistry = await make({
      token: true,
      registry: true,
    }).service.getStatus('a');
    expect(withRegistry.items.map((i) => i.kind)).not.toContain(
      CredentialKind.GHCR_PAT,
    );
    const onGhcr = await make({ token: true }).service.getStatus('a');
    expect(onGhcr.items.map((i) => i.kind)).toContain(CredentialKind.GHCR_PAT);
  });

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

  it('counts a connected token as GitHub connected where the installation uses tokens', async () => {
    const { service } = make({
      mode: GitHubAuthMethod.PAT,
      ghcr: CredentialStatus.UNKNOWN_EXPIRY,
    });
    const status = await service.getStatus('a');
    const github = status.items.filter(
      (i) => i.kind !== CredentialKind.PROVIDER,
    );
    expect(github).toEqual([
      expect.objectContaining({
        kind: CredentialKind.GITHUB_PAT,
        label: 'Your GitHub token',
      }),
    ]);
    expect(status.overallStatus).toBe(CredentialStatus.VALID);
  });

  it('asks for the token where the installation uses tokens and none is saved', async () => {
    const { service } = make({
      mode: GitHubAuthMethod.PAT,
      ghcr: CredentialStatus.MISSING,
    });
    const status = await service.getStatus('a');
    expect(status.items[0]).toMatchObject({
      kind: CredentialKind.GITHUB_PAT,
      status: CredentialStatus.MISSING,
    });
  });

  it('points to the setup when GitHub is not set up at all', async () => {
    const { service } = make({ mode: null });
    const status = await service.getStatus('a');
    expect(status.items[0]).toMatchObject({
      kind: CredentialKind.GITHUB_APP,
      actionUrl: '/apps/repositories/github-setup',
    });
  });
});

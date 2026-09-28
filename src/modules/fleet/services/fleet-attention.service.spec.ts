jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { FleetAttentionService } from './fleet-attention.service';
import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  CredentialKind,
  CredentialStatus,
} from '../../repositories/dto/ghcr-pat.dto';

const user = { userId: 'u1' } as never;

describe('FleetAttentionService', () => {
  function build(opts: { credentialsFail?: boolean } = {}) {
    const candidates = [{ id: 'mine' }, { id: 'theirs' }];
    const clusters = {
      find: jest.fn(async () => [
        {
          id: 'c1',
          name: 'wc-1',
          provider: 'hetzner',
          status: ClusterStatus.ERROR,
        },
      ]),
    };
    const access = {
      filterReadable: jest.fn(async (_u: unknown, apps: { id: string }[]) =>
        apps.filter((a) => a.id === 'mine'),
      ),
    };
    const coverage = {
      candidates: jest.fn(async () => candidates),
      forApplications: jest.fn(async (apps: { id: string }[]) => ({
        generatedAt: 'x',
        summary: {},
        applications: apps.map((a) => ({
          applicationId: a.id,
          name: a.id,
          kind: 'DATABASE',
          clusterId: 'c1',
          clusterName: 'wc-1',
          reason: 'no_policy',
          lastSuccessAt: null,
          alarm: true,
        })),
      })),
    };
    const credentials = {
      getStatus: jest.fn(async () => {
        if (opts.credentialsFail) throw new Error('down');
        return {
          overallStatus: CredentialStatus.MISSING,
          items: [
            {
              kind: CredentialKind.GITHUB_APP,
              label: 'GitHub App',
              status: CredentialStatus.MISSING,
              expiresAt: null,
              daysUntilExpiry: null,
              actionUrl: '/apps/repositories',
            },
          ],
        };
      }),
    };
    return {
      access,
      coverage,
      credentials,
      service: new FleetAttentionService(
        clusters as never,
        access as never,
        coverage as never,
        credentials as never,
      ),
    };
  }

  it('reports coverage only for the applications the caller may read', async () => {
    const { service, coverage, access } = build();
    const result = await service.coverageFor(user, 'c1');
    expect(coverage.candidates).toHaveBeenCalledWith('c1');
    expect(access.filterReadable).toHaveBeenCalledWith(user, [
      { id: 'mine' },
      { id: 'theirs' },
    ]);
    expect(result.applications.map((a) => a.applicationId)).toEqual(['mine']);
  });

  it('gathers clusters, credentials and unprotected data into one list', async () => {
    const { service, credentials } = build();
    const result = await service.needsYou(user);
    expect(credentials.getStatus).toHaveBeenCalledWith('u1');
    expect(result.items.map((i) => i.kind)).toEqual([
      'cluster_broken',
      'credential',
      'apps_without_backup',
    ]);
    expect(result.items[2].applications?.map((a) => a.applicationId)).toEqual([
      'mine',
    ]);
    expect(result.count).toBe(3);
  });

  it('still answers when the credential check fails', async () => {
    const { service } = build({ credentialsFail: true });
    const result = await service.needsYou(user);
    expect(result.items.map((i) => i.kind)).toEqual([
      'cluster_broken',
      'apps_without_backup',
    ]);
  });
});

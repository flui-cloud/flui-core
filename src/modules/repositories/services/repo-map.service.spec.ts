// `RepoMapService` is decorated, so TS emits real imports of everything its
// constructor names — including the token resolver's `@octokit/rest` (ESM-only)
// chain. Stubbed the same way the other specs in this module already do.
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
// Same for the Kubernetes client the capacity reader's types reach: ESM-only,
// and this spec never calls it for real.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));

import type { RepoScan } from '@flui-cloud/cartographer';
import { RepoMapService } from './repo-map.service';
import type { RepoTreeReaderService } from '../../applications/services/repo-tree-reader.service';
import type { ClustersService } from '../../infrastructure/clusters/clusters.service';
import type { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import type { CatalogAppDefinitionEntity } from '../../catalog/entities/catalog-app-definition.entity';

const DOCKERFILE = 'FROM node:20\nEXPOSE 8080\nCMD ["node", "src/server.js"]\n';
const COMPOSE = [
  'services:',
  '  db:',
  '    image: postgres:17',
  '    environment:',
  '      DATABASE_URL: postgres://x',
  '',
].join('\n');

function scanOf(files: Record<string, string>): RepoScan {
  return {
    root: 'acme/probe',
    files: Object.keys(files),
    truncated: false,
    read: (file: string) => files[file] ?? null,
    sources: () =>
      Object.entries(files)
        .filter(([path]) => path.endsWith('.js'))
        .map(([path, content]) => ({ path, content })),
  };
}

function serviceUnder(overrides: {
  tree?: Partial<RepoTreeReaderService>;
  clusters?: Partial<ClustersService>;
  kubernetes?: Partial<KubernetesService>;
  definition?: CatalogAppDefinitionEntity | null;
}) {
  const catalogDefinitions = {
    findOne: jest.fn(async () => overrides.definition ?? null),
  };
  return {
    service: new RepoMapService(
      overrides.tree as RepoTreeReaderService,
      overrides.kubernetes as KubernetesService,
      overrides.clusters as ClustersService,
      catalogDefinitions as never,
    ),
    catalogDefinitions,
  };
}

const READ_OK = {
  read: true as const,
  commitSha: 'a'.repeat(40),
  ref: 'main',
  truncated: false,
  contentComplete: true,
  skipped: { symlinks: 0, oversize: 0, other: 0 },
  bytesRead: 1024,
  highDensityUnread: [],
};

const REQUEST = {
  owner: 'acme',
  repo: 'probe',
  ref: 'main',
  repositoryId: 'repo-1',
};

describe('RepoMapService', () => {
  it('carries the citation and the firmness of every fact, not a verdict alone', async () => {
    const { service } = serviceUnder({
      tree: {
        readTree: async () => ({
          ...READ_OK,
          scan: scanOf({
            Dockerfile: DOCKERFILE,
            'package.json': '{"name":"probe"}',
          }),
        }),
      } as Partial<RepoTreeReaderService>,
    });

    const response = await service.mapFor('user-1', REQUEST);

    expect(response.read.ok).toBe(true);
    expect(response.read.commitSha).toBe('a'.repeat(40));
    const unit = response.map.units[0];
    expect(unit.port).toEqual({
      value: 8080,
      source: 'Dockerfile:EXPOSE',
      provenance: 'own',
    });
    expect(unit.confidence).toBe('declared');
    expect(unit.build.dockerfile.evidence[0].file).toBe('Dockerfile');
    expect(response.map.decisions[0].choice).toBe('dockerfile');
    expect(response.map.coverage).toBe('best_effort');
    // What was looked for and not found is part of the answer, not a silence.
    expect(response.map.boundary.notFound.length).toBeGreaterThan(0);
    expect(response.render.units[0].yaml).toContain('port: 8080');
  });

  it('answers the repository-only half and declares it when no cluster is named', async () => {
    const { service } = serviceUnder({
      tree: {
        readTree: async () => ({
          ...READ_OK,
          scan: scanOf({ Dockerfile: DOCKERFILE }),
        }),
      } as Partial<RepoTreeReaderService>,
    });

    const response = await service.mapFor('user-1', REQUEST);

    expect(response.verdict.outcome).toBe('deployable');
    expect(response.verdict.capacity.assessed).toBe(false);
    expect(response.verdict.capacity.notAssessedReason).toBe(
      'no-cluster-in-request',
    );
    expect(response.verdict.capacity.assessment.known).toBe(false);
    expect(response.verdict.capacity.assessment.fits).toBeUndefined();
  });

  it('weighs the map against the cluster when one is named', async () => {
    const { service } = serviceUnder({
      tree: {
        readTree: async () => ({
          ...READ_OK,
          scan: scanOf({ Dockerfile: DOCKERFILE }),
        }),
      } as Partial<RepoTreeReaderService>,
      clusters: {
        getKubeconfig: async () => 'kubeconfig',
      } as Partial<ClustersService>,
      kubernetes: {
        getNodeAllocatable: async () => ({ cpu: 4000, memory: 8000 }),
        getPodResourceRequests: async () => ({ cpu: 500, memory: 1000 }),
      } as Partial<KubernetesService>,
    });

    const response = await service.mapFor('user-1', {
      ...REQUEST,
      clusterId: 'cluster-1',
    });

    expect(response.verdict.capacity.assessed).toBe(true);
    expect(response.verdict.capacity.assessment).toMatchObject({
      known: true,
      fits: true,
      requiredCpuMillicores: 100,
      requiredMemoryMebibytes: 256,
    });
    expect(response.verdict.capacity.components[0].basis).toContain(
      'platform default',
    );
  });

  it('names a service it could not weigh instead of counting it as nothing', async () => {
    const { service, catalogDefinitions } = serviceUnder({
      tree: {
        readTree: async () => ({
          ...READ_OK,
          scan: scanOf({
            Dockerfile: DOCKERFILE,
            'docker-compose.yml': COMPOSE,
          }),
        }),
      } as Partial<RepoTreeReaderService>,
      clusters: {
        getKubeconfig: async () => 'kubeconfig',
      } as Partial<ClustersService>,
      kubernetes: {
        getNodeAllocatable: async () => ({ cpu: 4000, memory: 8000 }),
        getPodResourceRequests: async () => ({ cpu: 0, memory: 0 }),
      } as Partial<KubernetesService>,
      definition: null,
    });

    const response = await service.mapFor('user-1', {
      ...REQUEST,
      clusterId: 'cluster-1',
    });

    expect(catalogDefinitions.findOne).toHaveBeenCalled();
    expect(response.map.services.length).toBeGreaterThan(0);
    expect(response.verdict.capacity.uncounted.join(' ')).toContain(
      "is not in this installation's catalog",
    );
  });

  it('refuses to claim a fit when the cluster itself could not be read', async () => {
    const { service } = serviceUnder({
      tree: {
        readTree: async () => ({
          ...READ_OK,
          scan: scanOf({ Dockerfile: DOCKERFILE }),
        }),
      } as Partial<RepoTreeReaderService>,
      clusters: {
        getKubeconfig: async () => {
          throw new Error('no kubeconfig');
        },
      } as Partial<ClustersService>,
      kubernetes: {} as Partial<KubernetesService>,
    });

    const response = await service.mapFor('user-1', {
      ...REQUEST,
      clusterId: 'cluster-1',
    });

    expect(response.verdict.capacity.assessed).toBe(false);
    expect(response.verdict.capacity.notAssessedReason).toBe(
      'cluster-unreadable',
    );
    expect(response.verdict.capacity.assessment.known).toBe(false);
    // The footprints that were computed survive: the reader can see what would
    // have been weighed.
    expect(response.verdict.capacity.components).toHaveLength(1);
  });

  it('answers a repository it could not read instead of throwing', async () => {
    const { service } = serviceUnder({
      tree: {
        readTree: async () => ({
          read: false as const,
          reason: 'no-credential' as const,
          repoFullName: 'acme/probe',
          ref: 'main',
        }),
      } as Partial<RepoTreeReaderService>,
    });

    const response = await service.mapFor('user-1', REQUEST);

    expect(response.read.ok).toBe(false);
    expect(response.read.reason).toBe('no-credential');
    expect(response.map).toBeNull();
    expect(response.render).toBeNull();
    expect(response.verdict.outcome).toBe('not_assessed');
    expect(response.verdict.remedy).toContain('Reconnect the GitHub');
  });
});

// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; the restorer reaches it through the engine registry, stubbed here.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  CoreV1Api: class {},
  Exec: class {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { RebuildDataRestorer } from './rebuild-data-restorer.service';
import { ApplicationManifestGeneratorService } from '../../applications/services/application-manifest-generator.service';

/**
 * The seam between the two halves of a volume restore.
 *
 * One service decides what the pod must do and writes it on the row; another,
 * in another module, renders it. Each is tested on its own and both can be
 * right while the pod is wrong — a mount named after the volume the generator
 * calls something else, a container name the API server will not accept — and
 * nothing says so until a rebuild runs against a real cluster.
 */
describe('what the restorer declares is what the pod runs', () => {
  const gen = ApplicationManifestGeneratorService.prototype as any;
  const self = {
    companionsOf: gen.companionsOf,
    renderCompanionContainers: gen.renderCompanionContainers,
    fillSlug: gen.fillSlug,
  };

  function restorer() {
    const service = Object.create(
      RebuildDataRestorer.prototype,
    ) as RebuildDataRestorer;
    const r = service as unknown as Record<string, unknown>;
    r.logger = { log: jest.fn(), warn: jest.fn() };
    r.appRepo = { save: jest.fn(async (a: unknown) => a) };
    r.policyRepo = { findDbPolicyForApp: async () => null };
    r.artifactRepo = {
      findLatestDbArtifactForApp: async () => null,
      findLatestVolumeCopyForApp: async () => ({
        id: 'art-1',
        engineRef: 'export-1',
        manifestSummary: { sink: 's3-archive' },
        locations: [
          {
            role: 'primary',
            destinationId: 'dest-1',
            objectKeyPrefix: 'flui/cl-1/linkding/20260905120000-abc',
          },
        ],
      }),
    };
    r.destRepo = {
      findById: async () => ({
        id: 'dest-1',
        bucket: 'flui-backups',
        endpoint: 'https://s3.fr-par.scw.cloud',
        region: 'fr-par',
        accessKeyEncrypted: 'AK',
        secretKeyEncrypted: 'SK',
      }),
    };
    r.encryption = { decrypt: (v: string) => `plain-${v}` };
    r.engines = { all: () => [], forEngine: () => ({}) };
    return service;
  }

  const app = (over: Record<string, unknown> = {}) =>
    ({
      id: 'app-1',
      slug: 'linkding-7a6d82-h7ppt8',
      workloadKind: 'Deployment',
      env: [],
      volumes: [{ name: 'data', mountPath: '/etc/linkding/data' }],
      companions: {},
      ...over,
    }) as never;

  it('mounts the pod volume the workload declares, by the same name', async () => {
    // The mount is matched to the pod's `volumes:` entry by name, and that name
    // is `volume.name` in both workload kinds — not the claim, which differs.
    const row = app();
    await restorer().restoreInto(row, {} as never);

    const yaml: string = gen.renderInitContainersBlock.call(self, row);
    expect(yaml).toContain('initContainers:');
    expect(yaml).toContain('- name: flui-restore-data');
    expect(yaml).toContain('- name: data');
    expect(yaml).toContain('mountPath: /flui-restore');
  });

  it('reads the bucket credentials from the application’s own Secret', async () => {
    const row = app();
    await restorer().restoreInto(row, {} as never);

    const yaml: string = gen.renderInitContainersBlock.call(self, row);
    expect(yaml).toContain('secretRef:');
    expect(yaml).toContain('name: linkding-7a6d82-h7ppt8-secret');
    // The one thing that must never appear in a container spec.
    expect(yaml).not.toContain('plain-SK');
  });

  it('gives the container a name Kubernetes will accept', async () => {
    const row = app({
      volumes: [
        { name: 'a-very-long-volume-name-'.repeat(4), mountPath: '/d' },
      ],
    });
    await restorer().restoreInto(row, {} as never);

    const name = (
      row as never as {
        companions: { initContainers: Array<{ name: string }> };
      }
    ).companions.initContainers[0].name;
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });
});

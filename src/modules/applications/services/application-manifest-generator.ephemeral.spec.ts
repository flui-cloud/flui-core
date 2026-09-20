import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

/**
 * The only byte ceiling the kubelet actually enforces.
 *
 * The size declared on a volume is not enforced — a 1Mi claim accepted 50MiB on
 * a live cluster. What a container writes outside its volumes lands on the
 * node's own disk, which also holds k3s, its datastore, the images and the
 * logs; a runaway takes the node with it rather than annoying a neighbour.
 */
describe('what a generated workload may write outside its volumes', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const base = {
    id: 'app-1',
    slug: 'web',
    name: 'web',
    k8sNamespace: 'team-blue',
    replicas: 1,
    sourceConfig: { imageRef: 'nginx:1' },
  };

  const resourcesOf = (app: Partial<ApplicationEntity>) => {
    const manifests = generator.generateForDockerImage({
      ...base,
      ...app,
    } as unknown as ApplicationEntity);
    const workload = manifests.find(
      (m) => m.kind === 'Deployment' || m.kind === 'StatefulSet',
    )!;
    const doc = load(workload.yaml) as {
      spec: {
        template: {
          spec: {
            containers: Array<{
              resources: {
                requests: Record<string, string>;
                limits: Record<string, string>;
              };
            }>;
          };
        };
      };
    };
    return doc.spec.template.spec.containers[0].resources;
  };

  /**
   * The ceiling is a LimitRange on the namespace, and the manifest says nothing
   * — because anything it said would override the LimitRange a namespace may
   * already carry. One does: a sandbox tenancy is dosed at 1Gi a container
   * against a quota of 8Gi, and a manifest declaring 8Gi spent that tenancy on
   * a single container. Measured live: the guest's pod was refused admission
   * and the application sat in `provisioning` with nothing said.
   */
  it('declares nothing when the application asked for nothing', () => {
    const resources = resourcesOf({});
    expect(resources.requests['ephemeral-storage']).toBeUndefined();
    expect(resources.limits['ephemeral-storage']).toBeUndefined();
  });

  it('still declares cpu and memory, which were never the problem', () => {
    const resources = resourcesOf({});
    expect(resources.requests.cpu).toBe('100m');
    expect(resources.limits.memory).toBe('256Mi');
  });

  it('lets an application say its own, which is the point of the field', () => {
    const resources = resourcesOf({
      resources: {
        ephemeralStorage: { request: '32Mi', limit: '512Mi' },
      },
    } as Partial<ApplicationEntity>);
    expect(resources.requests['ephemeral-storage']).toBe('32Mi');
    expect(resources.limits['ephemeral-storage']).toBe('512Mi');
  });

  /**
   * A value the application declared is the one thing that belongs in its own
   * spec: a LimitRange default never overrides a container that speaks for
   * itself, so this is how an operator who genuinely needs 20Gi says so.
   */
  it('declares only the half that was given', () => {
    const onlyLimit = resourcesOf({
      resources: { ephemeralStorage: { limit: '512Mi' } },
    } as Partial<ApplicationEntity>);
    expect(onlyLimit.limits['ephemeral-storage']).toBe('512Mi');
    expect(onlyLimit.requests['ephemeral-storage']).toBeUndefined();
  });

  it('produces a manifest that still parses when it declares nothing', () => {
    expect(() => resourcesOf({})).not.toThrow();
  });
});

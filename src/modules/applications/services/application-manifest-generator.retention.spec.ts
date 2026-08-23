import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

/**
 * Decision 49: uninstalling an application takes its data with it, and where
 * Flui writes the StatefulSet itself the honest way to say so is on the
 * manifest — `persistentVolumeClaimRetentionPolicy` is native, and unlike the
 * name-based sweep it does not have to guess anything.
 *
 * Before this, there was not one occurrence of that field anywhere in the
 * project: what looked like a policy of keeping volumes was the Kubernetes
 * default (`Retain`) arriving unasked, inherited and never chosen.
 */
describe('what a generated StatefulSet says about its volumes', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const app = {
    id: 'app-1',
    slug: 'my-db',
    name: 'my-db',
    k8sNamespace: 'team-blue',
    replicas: 1,
    workloadKind: 'StatefulSet',
    volumes: [{ name: 'data', size: '10Gi', mountPath: '/var/lib/data' }],
    sourceConfig: { imageRef: 'postgres:16' },
  } as unknown as ApplicationEntity;

  const statefulSet = () => {
    const yaml = generator
      .generateForDockerImage(app)
      .find((m) => m.kind === 'StatefulSet')!.yaml;
    return load(yaml) as {
      spec: {
        persistentVolumeClaimRetentionPolicy?: {
          whenDeleted?: string;
          whenScaled?: string;
        };
        volumeClaimTemplates?: unknown[];
      };
    };
  };

  it('deleting the set takes its claims with it', () => {
    expect(
      statefulSet().spec.persistentVolumeClaimRetentionPolicy?.whenDeleted,
    ).toBe('Delete');
  });

  /**
   * Scaling in is reversible and routinely undone; deleting is not. Keeping the
   * claim of a replica that went away is the choice, made here rather than
   * inherited.
   */
  it('scaling in does not', () => {
    expect(
      statefulSet().spec.persistentVolumeClaimRetentionPolicy?.whenScaled,
    ).toBe('Retain');
  });

  it('still declares the claim template the policy applies to', () => {
    expect(statefulSet().spec.volumeClaimTemplates).toHaveLength(1);
  });
});

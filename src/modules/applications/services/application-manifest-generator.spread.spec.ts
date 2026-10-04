import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

describe('copies of an application on different nodes', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const podSpecOf = (over: Partial<ApplicationEntity>) => {
    const deployment = generator
      .generateForDockerImage({
        id: 'app-1',
        slug: 'my-api',
        name: 'my-api',
        k8sNamespace: 'default',
        replicas: 1,
        env: [],
        sourceConfig: { imageRef: 'nginx:1.27' },
        ...over,
      } as unknown as ApplicationEntity)
      .find((m) => m.kind === 'Deployment')!;
    const doc = load(deployment.yaml) as {
      spec: { template: { spec: Record<string, unknown> } };
    };
    return doc.spec.template.spec;
  };

  it('spreads two copies across nodes, and still runs them on one node if that is all there is', () => {
    expect(podSpecOf({ replicas: 2 }).topologySpreadConstraints).toEqual([
      {
        maxSkew: 1,
        topologyKey: 'kubernetes.io/hostname',
        whenUnsatisfiable: 'ScheduleAnyway',
        labelSelector: { matchLabels: { app: 'my-api' } },
      },
    ]);
  });

  it('spreads an autoscaled app that can grow past one copy', () => {
    const spec = podSpecOf({
      replicas: 1,
      scaling: { enabled: true, minReplicas: 1, maxReplicas: 4 },
    } as Partial<ApplicationEntity>);
    expect(spec.topologySpreadConstraints).toBeDefined();
  });

  it('adds nothing to a single copy', () => {
    expect(
      podSpecOf({ replicas: 1 }).topologySpreadConstraints,
    ).toBeUndefined();
  });

  it('leaves a dedicated app on the node it was bound to', () => {
    const spec = podSpecOf({
      replicas: 2,
      persistenceScope: 'dedicated',
      dedicatedNodeName: 'worker-1',
    } as Partial<ApplicationEntity>);
    expect(spec.topologySpreadConstraints).toBeUndefined();
    expect(spec.nodeSelector).toEqual({ 'kubernetes.io/hostname': 'worker-1' });
  });
});

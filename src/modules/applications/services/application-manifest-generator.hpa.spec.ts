import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

describe('replica autoscaling target', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const hpaOf = (scaling: ApplicationEntity['scaling']): string =>
    generator
      .generateForDockerImage({
        id: 'app-1',
        slug: 'my-api',
        name: 'my-api',
        k8sNamespace: 'default',
        replicas: 1,
        env: [],
        scaling,
        sourceConfig: { imageRef: 'nginx:1.27' },
      } as unknown as ApplicationEntity)
      .filter((m) => m.kind === 'HorizontalPodAutoscaler')
      .map((m) => m.yaml)
      .join('\n');

  it('writes the CPU target down when the app declares none', () => {
    const yaml = hpaOf({ enabled: true, minReplicas: 1, maxReplicas: 3 });
    expect(yaml).toContain('name: cpu');
    expect(yaml).toContain('averageUtilization: 80');
  });

  it('keeps a declared memory target without adding CPU', () => {
    const yaml = hpaOf({ enabled: true, targetMemory: 70 });
    expect(yaml).toContain('name: memory');
    expect(yaml).not.toContain('name: cpu');
  });
});

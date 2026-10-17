import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

describe("the API's own autoscaler", () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const app = (slug: string, k8sNamespace: string) =>
    ({
      id: 'app-1',
      slug,
      name: slug,
      k8sNamespace,
      replicas: 2,
      port: 3000,
      sourceConfig: { imageRef: 'core:1' },
      scaling: { enabled: true, horizontal: { min: 2, max: 5 } },
    }) as unknown as ApplicationEntity;

  const hpa = (a: ApplicationEntity) =>
    load(generator.autoscalerFor(a)?.yaml ?? '') as {
      spec: { behavior?: Record<string, any> };
    };

  it('gives copies back one at a time after ten quiet minutes', () => {
    const behavior = hpa(app('flui-api', 'flui-system')).spec.behavior;
    expect(behavior?.scaleDown.stabilizationWindowSeconds).toBe(600);
    expect(behavior?.scaleDown.policies[0].value).toBe(1);
    expect(behavior?.scaleUp.stabilizationWindowSeconds).toBe(0);
  });

  it('leaves other applications on the default behaviour', () => {
    expect(hpa(app('web', 'guest-1')).spec.behavior).toBeUndefined();
  });
});

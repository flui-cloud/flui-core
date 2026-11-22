import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

describe('a worker scaled on its queue', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const queue = {
    account: 'AACCOUNT',
    stream: 'ORDERS',
    consumer: 'mailer',
    lagThreshold: 20,
    min: 0,
    max: 4,
  };
  const render = (scaling: ApplicationEntity['scaling']) =>
    generator.generateForDockerImage({
      id: 'app-1',
      slug: 'mailer',
      name: 'mailer',
      k8sNamespace: 'p-shop',
      replicas: 1,
      env: [],
      scaling,
      sourceConfig: { imageRef: 'busybox:1' },
    } as unknown as ApplicationEntity);

  it('renders a queue autoscaler instead of the CPU one', () => {
    const kinds = render({ enabled: true, queue }).map((m) => m.kind);
    expect(kinds).toContain('ScaledObject');
    expect(kinds).not.toContain('HorizontalPodAutoscaler');
  });

  it('starts the workload at its floor, so an empty queue costs nothing', () => {
    const deployment = render({ enabled: true, queue }).find(
      (m) => m.kind === 'Deployment',
    )!;
    expect(deployment.yaml).toMatch(/replicas: 0\b/);
  });

  it('exposes nothing: a worker without a port gets no Service', () => {
    const kinds = render({ enabled: true, queue }).map((m) => m.kind);
    expect(kinds).not.toContain('Service');
  });

  it('is the autoscaler the stored app asks for', () => {
    const wanted = generator.autoscalerFor({
      slug: 'mailer',
      k8sNamespace: 'p-shop',
      scaling: { enabled: true, queue },
    } as unknown as ApplicationEntity);
    expect(wanted?.kind).toBe('ScaledObject');
    expect(JSON.parse(wanted!.yaml).spec.triggers[0].metadata.accountID).toBe(
      'AACCOUNT',
    );
  });
});

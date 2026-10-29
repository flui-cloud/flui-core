import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

const generator = new ApplicationManifestGeneratorService({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => (v.startsWith('enc:') ? v.slice(4) : v),
} as unknown as EncryptionService);

type Doc = {
  kind: string;
  spec: { strategy?: { type: string }; replicas: number };
};

function app(volumes: ApplicationEntity['volumes']): ApplicationEntity {
  return {
    id: 'app-1',
    slug: 'gitea-ab12',
    name: 'gitea-ab12',
    k8sNamespace: 'user-x',
    replicas: 1,
    port: 3000,
    volumes,
    sourceConfig: { type: 'docker_image', imageRef: 'gitea/gitea:1.24' },
  } as unknown as ApplicationEntity;
}

const deployment = (a: ApplicationEntity) =>
  generator
    .generateForDockerImage(a)
    .map((m) => ({ yaml: m.yaml, doc: load(m.yaml) as Doc }))
    .find((m) => m.doc.kind === 'Deployment')!;

describe('ApplicationManifestGenerator, replicated volumes', () => {
  it('replaces the pod instead of rolling it when a volume is replicated', () => {
    const d = deployment(
      app([
        {
          name: 'data',
          mountPath: '/data',
          size: '10Gi',
          storageClass: 'flui-replicated',
        },
      ] as ApplicationEntity['volumes']),
    );
    expect(d.doc.spec.strategy).toEqual({ type: 'Recreate' });
    expect(d.doc.spec.replicas).toBe(1);
  });

  it('leaves every other Deployment as it was, without a blank line where the strategy would go', () => {
    for (const volumes of [
      [],
      [{ name: 'data', mountPath: '/data', size: '10Gi' }],
      [
        {
          name: 'data',
          mountPath: '/data',
          size: '10Gi',
          storageClass: 'flui-local',
        },
      ],
    ] as ApplicationEntity['volumes'][]) {
      const d = deployment(app(volumes));
      expect(d.doc.spec.strategy).toBeUndefined();
      expect(d.yaml).not.toContain('STRATEGY_BLOCK');
      expect(d.yaml).toMatch(/ {2}replicas: 1\n {2}selector:/);
    }
  });
});

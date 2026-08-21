import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';

/**
 * A variable still awaiting a person must not reach the container. Either way of
 * "helping" is worse than absence:
 *
 *  - rendered into the Secret as an empty string, the app boots with a blank
 *    credential it accepts — `POSTGRES_PASSWORD=""` is an open door, not a
 *    misconfiguration someone notices;
 *  - bound with a `secretKeyRef` to a key that is not in the Secret, the pod
 *    sits in CreateContainerConfigError, which reads as a broken deploy rather
 *    than as a value somebody still has to supply.
 *
 * So it is skipped entirely, and an app that needs it fails loudly at boot for
 * the reason that is actually true.
 */
describe('manifest generation with a variable still awaiting a value', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const appWith = (env: ApplicationEntity['env']): ApplicationEntity =>
    ({
      id: 'app-1',
      slug: 'my-api',
      name: 'my-api',
      k8sNamespace: 'default',
      replicas: 1,
      env,
      sourceConfig: { imageRef: 'nginx:1.27' },
    }) as unknown as ApplicationEntity;

  const yamlOf = (app: ApplicationEntity, kind: string): string =>
    generator
      .generateForDockerImage(app)
      .filter((m) => m.kind === kind)
      .map((m) => m.yaml)
      .join('\n');

  it('keeps the pending key out of the Secret', () => {
    const app = appWith([
      { name: 'SET', value: 'known', secret: true, source: 'user' },
      {
        name: 'WAITING',
        value: '',
        secret: true,
        pending: true,
        source: 'user',
      },
    ]);
    const secret = yamlOf(app, 'Secret');
    expect(secret).toContain('SET');
    expect(secret).not.toContain('WAITING');
  });

  it('does not bind it into the container env either', () => {
    const app = appWith([
      {
        name: 'WAITING',
        value: '',
        secret: true,
        pending: true,
        source: 'user',
      },
    ]);
    expect(yamlOf(app, 'Deployment')).not.toContain('WAITING');
  });

  it('generates no Secret at all when every sensitive key is still awaited', () => {
    const app = appWith([
      { name: 'PLAIN', value: 'x', source: 'user' },
      {
        name: 'WAITING',
        value: '',
        secret: true,
        pending: true,
        source: 'user',
      },
    ]);
    expect(yamlOf(app, 'Secret')).toBe('');
  });

  it('leaves ordinary variables exactly where they were', () => {
    const app = appWith([
      { name: 'PLAIN', value: 'x', source: 'user' },
      { name: 'SET', value: 'known', secret: true, source: 'user' },
    ]);
    expect(yamlOf(app, 'ConfigMap')).toContain('PLAIN');
    expect(yamlOf(app, 'Secret')).toContain('SET');
    const deployment = yamlOf(app, 'Deployment');
    expect(deployment).toContain('PLAIN');
    expect(deployment).toContain('SET');
  });
});

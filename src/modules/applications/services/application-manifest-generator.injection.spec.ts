import { loadAll } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';
import { appManifestRefusal } from '../utils/app-manifest-scope';

/**
 * F-091: the generated YAML is applied with the cluster's admin credentials, so
 * no field a person can set may close its own value and start another object.
 */
describe('manifest generation keeps what a person typed inside its own value', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);

  const base = {
    id: 'app-1',
    slug: 'web',
    name: 'web',
    k8sNamespace: 'guest-1',
    replicas: 1,
    port: 80,
    sourceConfig: { imageRef: 'nginx:1' },
  };
  const escape =
    '"\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRoleBinding\nmetadata:\n  name: owned\n';

  const generate = (app: Record<string, unknown>) =>
    generator.generateForDockerImage({
      ...base,
      ...app,
    } as unknown as ApplicationEntity);

  it('renders a hostile label value as one string in one document', () => {
    for (const manifest of generate({ labels: { team: escape } })) {
      const docs = loadAll(manifest.yaml) as Array<{
        kind: string;
        metadata: { labels?: Record<string, string> };
      }>;
      expect(docs).toHaveLength(1);
      expect(appManifestRefusal(docs, 'guest-1')).toBeNull();
      if (docs[0].metadata.labels?.team)
        expect(docs[0].metadata.labels.team).toBe(escape);
    }
  });

  it('keeps a hostile start command inside the container', () => {
    const [workload] = generate({ startCommand: `npm start${escape}` }).filter(
      (m) => m.kind === 'Deployment',
    );
    expect(loadAll(workload.yaml)).toHaveLength(1);
  });

  it.each([
    ['slug', { slug: 'web\n---' }],
    ['namespace', { k8sNamespace: 'kube-system"\n' }],
    ['variable name', { env: [{ name: `X${escape}`, value: '1' }] }],
    [
      'secret reference',
      {
        env: [
          {
            name: 'X',
            value: '',
            externalSecretRef: { secretName: `s${escape}`, key: 'k' },
          },
        ],
      },
    ],
    [
      'volume name',
      { volumes: [{ name: `data${escape}`, mountPath: '/data' }] },
    ],
    [
      'mount path',
      { volumes: [{ name: 'data', mountPath: `/data${escape}` }] },
    ],
    [
      'config file path',
      { configFiles: [{ path: `/etc/x${escape}`, content: 'x' }] },
    ],
    ['image', { sourceConfig: { imageRef: `nginx:1${escape}` } }],
    ['cpu', { resources: { cpu: { limit: `1${escape}` } } }],
    ['runAsUser', { securityContext: { runAsUser: `0${escape}` } }],
    [
      'companion image',
      {
        companions: { sidecars: [{ name: 'side', image: `busybox${escape}` }] },
      },
    ],
    [
      'companion mount path',
      {
        companions: {
          sidecars: [
            {
              name: 'side',
              image: 'busybox',
              mounts: [{ name: 'v', mountPath: `/x${escape}` }],
            },
          ],
        },
      },
    ],
  ])('refuses a %s that could break out of the manifest', (_, app) => {
    expect(() => generate(app)).toThrow(/cannot be deployed/);
  });

  it('refuses a schedule that could break out of the CronJob', () => {
    expect(() =>
      generator.generateCronJob(
        base as unknown as ApplicationEntity,
        {
          name: 'web-nightly',
          displayName: 'nightly',
          schedule: `0 3 * * *${escape}`,
          command: 'true',
        } as never,
      ),
    ).toThrow(/cannot be deployed/);
  });
});

describe('an application manifest stays inside its namespace', () => {
  it('refuses cluster-wide kinds, other namespaces and documents without one', () => {
    expect(
      appManifestRefusal(
        [{ kind: 'ClusterRoleBinding', metadata: { name: 'x' } }],
        'guest-1',
      ),
    ).toMatch(/cannot create a ClusterRoleBinding/);
    expect(
      appManifestRefusal(
        [{ kind: 'Pod', metadata: { namespace: 'guest-1' } }],
        'guest-1',
      ),
    ).toMatch(/cannot create a Pod/);
    expect(
      appManifestRefusal(
        [
          {
            kind: 'Deployment',
            metadata: { name: 'x', namespace: 'kube-system' },
          },
        ],
        'guest-1',
      ),
    ).toMatch(/not in the application's namespace/);
    expect(
      appManifestRefusal(
        [{ kind: 'Secret', metadata: { name: 'x' } }],
        'guest-1',
      ),
    ).toMatch(/not in the application's namespace/);
  });

  it('lets an application own its workload, service and configuration', () => {
    expect(
      appManifestRefusal(
        [
          {
            kind: 'Deployment',
            metadata: { name: 'web', namespace: 'guest-1' },
          },
          {
            kind: 'Service',
            metadata: { name: 'web-svc', namespace: 'guest-1' },
          },
        ],
        'guest-1',
      ),
    ).toBeNull();
  });
});

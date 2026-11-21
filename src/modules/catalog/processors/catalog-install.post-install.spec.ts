jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { CatalogInstallProcessor } from './catalog-install.processor';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import { CatalogSpec } from '../interfaces/catalog-manifest.interface';

function processor() {
  const execInPod = jest.fn().mockResolvedValue('created');
  const self = Object.create(CatalogInstallProcessor.prototype);
  Object.assign(self, {
    logger: { log: jest.fn(), warn: jest.fn() },
    installRepo: {
      findById: jest.fn().mockResolvedValue({ resolvedFqdn: '' }),
    },
    applicationRepo: {
      findById: jest
        .fn()
        .mockResolvedValue({ slug: 'gitea-ab12', k8sNamespace: 'user-x' }),
    },
    kubernetesService: { execInPod },
    getClusterKubeconfigContent: jest.fn().mockResolvedValue('kubeconfig'),
  });
  return {
    execInPod,
    run: (spec: CatalogSpec, appIdByComponent = new Map<string, string>()) =>
      (
        self as {
          maybeRunPostInstall(
            install: unknown,
            spec: CatalogSpec,
            primaryAppId: string,
            oidc: null,
            components: Record<string, never>,
            appIdByComponent: Map<string, string>,
          ): Promise<void>;
        }
      ).maybeRunPostInstall(
        { id: 'i1', clusterId: 'c1', options: {} },
        spec,
        'app-1',
        null,
        {},
        appIdByComponent,
      ),
  };
}

function standalone(postInstall: CatalogSpec['postInstall']): CatalogSpec {
  return {
    type: CatalogAppType.STANDALONE,
    image: { registry: 'docker.io', repository: 'x', tag: '1' },
    ports: [],
    postInstall,
  } as unknown as CatalogSpec;
}

describe('post-install steps of a standalone entry', () => {
  it('runs an exec step in the application container', async () => {
    const p = processor();
    await p.run(
      standalone([
        { name: 'create-admin', exec: { command: ['/bin/sh', '-c', 'echo'] } },
      ]),
    );
    expect(p.execInPod).toHaveBeenCalledWith(
      'kubeconfig',
      'user-x',
      'flui-app-id=app-1',
      'gitea-ab12',
      ['/bin/sh', '-c', 'echo'],
    );
  });

  it('skips a step gated on an option, since a standalone entry has none', async () => {
    const p = processor();
    await p.run(
      standalone([
        {
          name: 'only-with-option',
          when: { option: 'extra' },
          exec: { command: ['true'] },
        },
      ]),
    );
    expect(p.execInPod).not.toHaveBeenCalled();
  });
});

describe('post-install steps of a composed entry', () => {
  const composed = (component: string): CatalogSpec =>
    ({
      type: CatalogAppType.COMPOSED,
      components: [],
      postInstall: [
        { name: 'create-admin', exec: { component, command: ['true'] } },
      ],
    }) as unknown as CatalogSpec;

  it('runs the command in the component it names', async () => {
    const p = processor();
    await p.run(
      composed('backend'),
      new Map([
        ['frontend', 'app-1'],
        ['backend', 'app-2'],
      ]),
    );
    expect(p.execInPod).toHaveBeenCalledWith(
      'kubeconfig',
      'user-x',
      'flui-app-id=app-2',
      'gitea-ab12',
      ['true'],
    );
  });

  it('skips a command for a component the install does not have', async () => {
    const p = processor();
    await p.run(composed('missing'), new Map([['frontend', 'app-1']]));
    expect(p.execInPod).not.toHaveBeenCalled();
  });
});

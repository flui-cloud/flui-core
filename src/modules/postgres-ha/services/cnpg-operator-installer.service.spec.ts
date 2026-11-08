jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('../utils/cnpg-images', () => ({
  pinnedCnpgManifest: (manifest: string) => `pinned ${manifest}`,
}));

import { CnpgOperatorInstallerService } from './cnpg-operator-installer.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { CNPG_MANIFEST_URL } from '../postgres-ha.constants';

const ready = { spec: { replicas: 1 }, status: { availableReplicas: 1 } };

function setup(deployments: Array<unknown>) {
  const kubernetes = {
    getResource: jest.fn(async () =>
      deployments.length ? deployments.shift() : ready,
    ),
    serverSideApply: jest.fn(async () => 42),
    applyManifest: jest.fn(),
    mergePatchObject: jest.fn(),
  } as unknown as KubernetesService;
  const fetchMock = jest
    .spyOn(global, 'fetch')
    .mockResolvedValue(new Response('kind: Namespace', { status: 200 }));
  return {
    installer: new CnpgOperatorInstallerService(kubernetes),
    kubernetes,
    fetchMock,
  };
}

describe('installing the Postgres HA operator only when it is needed', () => {
  afterEach(() => jest.restoreAllMocks());

  it('applies nothing on a cluster that already has it', async () => {
    const { installer, kubernetes, fetchMock } = setup([ready, ready]);
    await installer.ensureInstalled('kc');
    expect(kubernetes.serverSideApply).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Its resource definitions are too large for a client-side apply's annotation. */
  it('applies the pinned release server-side the first time', async () => {
    const { installer, kubernetes, fetchMock } = setup([null, ready]);
    await installer.ensureInstalled('kc');
    expect(fetchMock).toHaveBeenCalledWith(CNPG_MANIFEST_URL);
    expect(kubernetes.serverSideApply).toHaveBeenCalledWith(
      'kc',
      'pinned kind: Namespace',
    );
    expect(kubernetes.applyManifest).not.toHaveBeenCalled();
  });

  it('runs the operator as two copies in different locations, on every pass', async () => {
    const { installer, kubernetes } = setup([ready, ready]);
    await installer.ensureInstalled('kc');
    expect(kubernetes.mergePatchObject).toHaveBeenCalledWith(
      'kc',
      expect.objectContaining({
        kind: 'Deployment',
        metadata: { name: 'cnpg-controller-manager', namespace: 'cnpg-system' },
        spec: expect.objectContaining({
          replicas: 2,
          template: {
            spec: expect.objectContaining({
              affinity: {
                podAntiAffinity: {
                  requiredDuringSchedulingIgnoredDuringExecution: [
                    expect.objectContaining({
                      topologyKey: 'topology.kubernetes.io/zone',
                    }),
                  ],
                },
              },
            }),
          },
        }),
      }),
    );
  });

  it('is ready as soon as one copy answers, so a location away does not stop it', async () => {
    const { installer } = setup([
      ready,
      { spec: { replicas: 2 }, status: { availableReplicas: 1 } },
    ]);
    await expect(installer.ensureInstalled('kc')).resolves.toBeUndefined();
  });

  it('says where the manifest could not be fetched from', async () => {
    const { installer } = setup([null]);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('', { status: 404 }));
    await expect(installer.ensureInstalled('kc')).rejects.toThrow(
      CNPG_MANIFEST_URL,
    );
  });
});

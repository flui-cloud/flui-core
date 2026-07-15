// Pulled in transitively and ship ESM that jest won't parse; unused on these paths.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterOrchestrationService } from './cluster-orchestration.service';

/**
 * The queue re-runs createMasterNode from the top on thrown errors AND on stalled
 * jobs, so anything it mints instead of deriving breaks the second run.
 */
describe('ClusterOrchestrationService — retry safety', () => {
  const CLUSTER = { id: 'cluster-1', name: 'workload-1', provider: 'hetzner' };

  function build(overrides: Record<string, unknown> = {}) {
    const service = Object.create(
      ClusterOrchestrationService.prototype,
    ) as ClusterOrchestrationService;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      sleep: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    });
    return service;
  }

  describe('ensureBootstrapKey', () => {
    const call = (service: ClusterOrchestrationService, cluster: unknown) =>
      (
        service as unknown as {
          ensureBootstrapKey: (c: unknown, n: string) => Promise<unknown>;
        }
      ).ensureBootstrapKey(cluster, 'master');

    // The bug: cloud-init ran once at first boot, so retry 2 authenticated with a
    // key the node had never seen and died on "Permission denied (publickey)".
    it('reuses the recorded key instead of minting a second one', async () => {
      const accessService = {
        getBootstrapKeyMaterialForCluster: jest.fn().mockResolvedValue({
          id: 'key-1',
          publicKey: 'ssh-ed25519 AAAA-existing',
          privateKey: 'PRIV-existing',
        }),
        createSSHKey: jest.fn(),
      };
      const keyGenerator = { generateKeyPair: jest.fn() };
      const service = build({ accessService, keyGenerator });

      const result = await call(service, CLUSTER);

      expect(keyGenerator.generateKeyPair).not.toHaveBeenCalled();
      expect(accessService.createSSHKey).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 'key-1',
        publicKey: 'ssh-ed25519 AAAA-existing',
        privateKey: 'PRIV-existing',
      });
    });

    it('mints and records one when the cluster has none', async () => {
      const accessService = {
        getBootstrapKeyMaterialForCluster: jest.fn().mockResolvedValue(null),
        createSSHKey: jest.fn().mockResolvedValue({ id: 'key-new' }),
      };
      const keyGenerator = {
        generateKeyPair: jest.fn().mockResolvedValue({
          publicKey: 'ssh-ed25519 AAAA-new',
          privateKey: 'PRIV-new',
          fingerprint: 'fp',
        }),
      };
      const clusterRepository = { update: jest.fn() };
      const service = build({
        accessService,
        keyGenerator,
        clusterRepository,
        debugLogBootstrapKey: jest.fn(),
      });

      const cluster = { ...CLUSTER };
      const result = await call(service, cluster);

      // Recorded, or the next retry can't find it.
      expect(clusterRepository.update).toHaveBeenCalledWith('cluster-1', {
        bootstrapKeyId: 'key-new',
      });
      expect(cluster).toMatchObject({ bootstrapKeyId: 'key-new' });
      expect(result).toMatchObject({ id: 'key-new', privateKey: 'PRIV-new' });
    });
  });

  describe('fetchKubeconfigFromMaster', () => {
    const call = (service: ClusterOrchestrationService) =>
      (
        service as unknown as {
          fetchKubeconfigFromMaster: (
            ip: string,
            key: string,
            serverIp: string,
          ) => Promise<string>;
        }
      ).fetchKubeconfigFromMaster('10.0.0.1', 'PRIV', '10.0.0.1');

    it('keeps polling while k3s has not written the file yet', async () => {
      const execCommand = jest
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'cat: /etc/rancher/k3s/k3s.yaml: No such file or directory',
          ),
        )
        .mockRejectedValueOnce(new Error('No such file or directory'))
        .mockResolvedValue('apiVersion: v1\nserver: https://127.0.0.1:6443');
      const service = build({ nativeSsh: { execCommand } });

      const kubeconfig = await call(service);

      expect(execCommand).toHaveBeenCalledTimes(3);
      expect(kubeconfig).toContain('https://10.0.0.1:6443');
    });

    it('fails immediately when the master rejects the key', async () => {
      const execCommand = jest
        .fn()
        .mockRejectedValue(
          new Error(
            'SSH exec failed (code 255): Permission denied (publickey).',
          ),
        );
      const sleep = jest.fn().mockResolvedValue(undefined);
      const service = build({ nativeSsh: { execCommand }, sleep });

      await expect(call(service)).rejects.toThrow(/rejected the bootstrap key/);
      expect(execCommand).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('rejects a truncated kubeconfig rather than persisting it', async () => {
      const execCommand = jest
        .fn()
        .mockResolvedValueOnce('')
        .mockResolvedValue('apiVersion: v1');
      const service = build({ nativeSsh: { execCommand } });

      await expect(call(service)).resolves.toContain('apiVersion');
      expect(execCommand).toHaveBeenCalledTimes(2);
    });
  });
});

jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});

jest.mock('../lib/vault/require-vault', () => ({
  requireOpenVault: jest.fn(),
}));

import { CliClustersService } from './cli-clusters.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import type { SshMode } from '../lib/ssh-mode';

function serviceWith(caService: {
  getCaPublicKey: jest.Mock;
}): CliClustersService {
  const repository = {
    create: (input: unknown) => ({ id: 'cluster-1', ...(input as object) }),
    save: jest.fn(async (entity: unknown) => entity),
  };
  return new CliClustersService(
    repository as never,
    repository as never,
    repository as never,
    repository as never,
    {
      encrypt: (value: string) => `sealed:${value}`,
      exportKeyMaterialForBundle: () => ({ keyHex: '00'.repeat(32) }),
    } as never,
    {
      getOrCreateSshKey: async () => ({ publicKey: 'ssh-ed25519 AAAA' }),
    } as never,
    caService as never,
    {} as never,
    {} as never,
    { add: jest.fn() },
  );
}

const create = (service: CliClustersService, sshMode: SshMode) =>
  service.create({
    name: 'control-cluster',
    provider: CloudProvider.HETZNER,
    region: 'nbg1',
    nodeSize: 'cx33',
    workerCount: 0,
    metadata: { isObservabilityCluster: true, sshMode },
  } as never);

describe('creating a cluster record', () => {
  /**
   * The CA getter creates one as a side effect. A cluster built for someone
   * else must leave no CA behind on the machine that built it.
   */
  it('creates no certificate authority in ephemeral-key mode', async () => {
    const caService = { getCaPublicKey: jest.fn() };

    const { cluster } = await create(serviceWith(caService), 'ephemeral-key');

    expect(caService.getCaPublicKey).not.toHaveBeenCalled();
    expect((cluster.metadata as { caPublicKey?: string }).caPublicKey).toBe('');
  });

  it('enrols this machine’s certificate authority in ca mode', async () => {
    const caService = {
      getCaPublicKey: jest.fn(async () => 'ssh-ed25519 CA'),
    };

    const { cluster } = await create(serviceWith(caService), 'ca');

    expect(caService.getCaPublicKey).toHaveBeenCalled();
    expect((cluster.metadata as { caPublicKey?: string }).caPublicKey).toBe(
      'ssh-ed25519 CA',
    );
  });
});

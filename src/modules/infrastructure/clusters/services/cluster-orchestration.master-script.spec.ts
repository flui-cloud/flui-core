jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterOrchestrationService } from './cluster-orchestration.service';
import { ClusterType } from '../entities/cluster.entity';

const STOP = new Error('stop after the boot script');

describe('the boot script a new master receives', () => {
  function build(plan: Record<string, unknown>) {
    const generateMasterScript = jest.fn().mockResolvedValue('#!/bin/bash');
    const service = Object.create(
      ClusterOrchestrationService.prototype,
    ) as ClusterOrchestrationService;
    Object.assign(service, {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      updateOperationProgress: jest.fn(),
      encryptionService: { decrypt: () => 'k3s-token' },
      loadCaKeyPair: jest
        .fn()
        .mockResolvedValue({ caPublicKey: 'ca-pub', caPrivateKey: 'ca-priv' }),
      resolveControlClusterIp: jest.fn().mockResolvedValue('203.0.113.5'),
      capabilitiesFactory: { isProviderSupported: () => false },
      ensureNodeRecord: jest.fn().mockResolvedValue({ id: 'node-1' }),
      privateNetworksOf: jest.fn().mockResolvedValue([]),
      overlayPlanFor: jest.fn().mockResolvedValue(plan),
      hostFirewallAtBoot: jest.fn().mockResolvedValue(undefined),
      k3sScriptService: { generateMasterScript },
      ensureBootstrapKey: jest
        .fn()
        .mockResolvedValue({ id: 'key-1', publicKey: 'ssh-ed25519 AAAA' }),
      providerFactory: { getProvider: () => ({}) },
      labelService: { generateServerLabels: () => ({}) },
      operationRepository: {
        create: () => {
          throw STOP;
        },
      },
    });
    const create = () =>
      service.createMasterNode(
        {
          id: 'c1',
          name: 'lab',
          provider: 'hetzner',
          region: 'fsn1',
          clusterType: ClusterType.WORKLOAD,
          sharedStorageEnabled: false,
        } as never,
        'op-1',
      );
    return { create, generateMasterScript };
  }

  it('keeps the Flui network settings alongside the bootstrap key', async () => {
    const control = {
      publicKey: 'k-control',
      address: '10.250.0.1',
      endpoint: '198.51.100.7:51821',
    };
    const peers = [
      { publicKey: 'k-peer', address: '10.250.0.2', endpoint: 'x:51821' },
    ];
    const { create, generateMasterScript } = build({
      address: '10.250.0.9',
      mode: 'overlay',
      peers,
      control,
    });

    await expect(create()).rejects.toBe(STOP);

    expect(generateMasterScript).toHaveBeenCalledTimes(1);
    expect(generateMasterScript.mock.calls[0][0]).toMatchObject({
      wgAddress: '10.250.0.9',
      wgControl: control,
      wgMode: 'overlay',
      wgPeers: peers,
      bootstrapPublicKey: 'ssh-ed25519 AAAA',
    });
  });

  /** In a network Flui builds, the private address is the tunnel one and the boot script refuses to guess it. */
  it('tells a mesh master its private address', async () => {
    const { create, generateMasterScript } = build({
      address: '10.250.0.9',
      mode: 'mesh',
      peers: [],
    });

    await expect(create()).rejects.toBe(STOP);

    expect(generateMasterScript.mock.calls[0][0]).toMatchObject({
      wgMode: 'mesh',
      privateIp: '10.250.0.9',
      bootstrapPublicKey: 'ssh-ed25519 AAAA',
    });
  });
});

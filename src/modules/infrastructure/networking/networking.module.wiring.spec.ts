// Pulled in transitively by ProvidersModule and ship ESM that Jest won't parse.
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { WireGuardPeerEntity } from './entities/wireguard-peer.entity';
import { VNetEntity } from '../vnets/entities/vnet.entity';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { WireGuardPeerService } from './services/wireguard-peer.service';
import { WireGuardReconciler } from './services/wireguard-reconciler.service';
import { ApiServerSanService } from './services/api-server-san.service';
import { WireGuardReconciliationScheduler } from './schedulers/wireguard-reconciliation.scheduler';
import { HostCommandService } from '../../providers/core/host/host-command.service';
import { ManagementAddressResolver } from '../shared/services/management-address.resolver';

/**
 * Resolves this module's own graph, because the type-checker cannot.
 *
 * A constructor gains a dependency, the class compiles, every unit test passes
 * — they build the service with `new` — and the API crash-loops at boot with
 * "Nest can't resolve dependencies". That is not hypothetical: it happened on a
 * real installation when `WireGuardReconciler` gained `ManagementAddressResolver`
 * and the module was never told where that comes from.
 *
 * Declared here rather than importing `NetworkingModule` itself: doing that
 * would drag in TypeORM, Bull and every provider module, so the test would
 * mostly exercise infrastructure. What matters is the shape the module
 * declares — the same providers, the same external seams — which is what this
 * mirrors. Keep the two in step: a provider added there belongs here too.
 */
@Module({
  providers: [
    WireGuardPeerService,
    WireGuardReconciler,
    WireGuardReconciliationScheduler,
    ApiServerSanService,
    // What NetworkingModule gets from the modules it imports. Listing them is
    // the point: if a class needs something no import supplies, it is missing
    // from here too and the resolution below fails.
    ManagementAddressResolver,
    { provide: HostCommandService, useValue: {} },
    { provide: getRepositoryToken(WireGuardPeerEntity), useValue: {} },
    { provide: getRepositoryToken(VNetEntity), useValue: {} },
    { provide: getRepositoryToken(ClusterEntity), useValue: {} },
    {
      provide: getRepositoryToken(InfrastructureOperationEntity),
      useValue: {},
    },
    { provide: getQueueToken('infrastructure'), useValue: { add: jest.fn() } },
  ],
})
class NetworkingWiringHarness {}

describe('the networking module resolves its own graph', () => {
  const build = () =>
    Test.createTestingModule({ imports: [NetworkingWiringHarness] }).compile();

  it('builds every provider it declares', async () => {
    const moduleRef = await build();

    expect(moduleRef.get(WireGuardPeerService)).toBeDefined();
    expect(moduleRef.get(WireGuardReconciler)).toBeDefined();
    expect(moduleRef.get(ApiServerSanService)).toBeDefined();
    expect(moduleRef.get(WireGuardReconciliationScheduler)).toBeDefined();
  });

  it('gives the reconciler the resolver it now needs', async () => {
    // The dependency the real module had no source for.
    const moduleRef = await build();
    const reconciler = moduleRef.get(WireGuardReconciler);

    expect(
      (reconciler as unknown as { managementAddress: unknown })
        .managementAddress,
    ).toBeInstanceOf(ManagementAddressResolver);
  });
});

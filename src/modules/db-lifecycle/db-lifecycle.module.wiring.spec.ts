jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bull';
import { DbReplicationLinkEntity } from './entities/db-replication-link.entity';
import { DbMigrationEntity } from './entities/db-migration.entity';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../infrastructure/clusters/entities/cluster-node.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';
import { CatalogInstallEntity } from '../catalog/entities/catalog-install.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { DbReplicationService } from './services/db-replication.service';
import { DbPodExecService } from './services/db-pod-exec.service';
import { DbReplicationTransportService } from './services/db-replication-transport.service';
import { DbReplicationStatusService } from './services/db-replication-status.service';
import { DbMigrationService } from './services/db-migration.service';
import { DbMigrationProcessor } from './processors/db-migration.processor';
import { DbWriteFenceService } from './services/db-write-fence.service';
import { DbPodPlacementService } from './services/db-pod-placement.service';
import { DbOverlayTransportService } from './services/db-overlay-transport.service';
import { DbPhysicalReplicationService } from './services/db-physical-replication.service';
import { DbCredentialHandoffService } from './services/db-credential-handoff.service';
import { DbMigrationRecoveryService } from './services/db-migration-recovery.service';
import { DbMigrationViewService } from './services/db-migration-view.service';
import { DbPoolerCutService } from './services/db-pooler-cut.service';
import { PoolerPauseSweeper } from './services/pooler-pause.sweeper';
import { WireGuardLinkEntity } from '../infrastructure/networking/entities/wireguard-link.entity';
import { FullMigrationEntity } from '../full-migration/entities/full-migration.entity';
import { DB_LIFECYCLE_QUEUE } from './db-lifecycle.constants';
import { KubernetesService } from '../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../shared/encryption/services/encryption.service';
import { CatalogInstallerService } from '../catalog/services/catalog-installer.service';
import { BlockConnectionUrlService } from '../catalog/services/block-connection-url.service';
import { DbPoolerService } from '../catalog/services/db-pooler.service';
import { RestoreJobsService } from '../backups/services/restore-jobs.service';
import { DbPitrService } from '../backups/services/db-pitr.service';
import { WireGuardPeerService } from '../infrastructure/networking/services/wireguard-peer.service';
import { WireGuardLinkService } from '../infrastructure/networking/services/wireguard-link.service';

/**
 * Mirrors DbLifecycleModule's providers and the seams its imports supply, so
 * a constructor that gains a dependency no import provides fails here rather
 * than at boot. Keep it in step with the module.
 */
@Module({
  providers: [
    DbReplicationService,
    DbPodExecService,
    DbReplicationTransportService,
    DbReplicationStatusService,
    DbMigrationService,
    DbMigrationProcessor,
    DbWriteFenceService,
    DbPodPlacementService,
    DbOverlayTransportService,
    DbPhysicalReplicationService,
    DbCredentialHandoffService,
    DbMigrationRecoveryService,
    DbMigrationViewService,
    DbPoolerCutService,
    PoolerPauseSweeper,
    ...[
      DbReplicationLinkEntity,
      DbMigrationEntity,
      ApplicationEntity,
      ClusterEntity,
      ClusterNodeEntity,
      InfrastructureOperationEntity,
      CatalogInstallEntity,
      UserEntity,
      WireGuardLinkEntity,
      FullMigrationEntity,
    ].map((e) => ({ provide: getRepositoryToken(e), useValue: {} })),
    {
      provide: getQueueToken(DB_LIFECYCLE_QUEUE),
      useValue: { add: jest.fn() },
    },
    { provide: KubernetesService, useValue: {} },
    { provide: EncryptionService, useValue: {} },
    { provide: CatalogInstallerService, useValue: {} },
    { provide: BlockConnectionUrlService, useValue: {} },
    { provide: DbPoolerService, useValue: {} },
    { provide: RestoreJobsService, useValue: {} },
    { provide: DbPitrService, useValue: {} },
    { provide: WireGuardPeerService, useValue: {} },
    { provide: WireGuardLinkService, useValue: {} },
  ],
})
class DbLifecycleWiringHarness {}

describe('the db-lifecycle module resolves its own graph', () => {
  it('builds the physical path with everything it needs', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DbLifecycleWiringHarness],
    }).compile();
    expect(moduleRef.get(DbMigrationProcessor)).toBeDefined();
    expect(moduleRef.get(DbPhysicalReplicationService)).toBeDefined();
    expect(moduleRef.get(DbMigrationRecoveryService)).toBeDefined();
    expect(moduleRef.get(DbMigrationService)).toBeDefined();
    expect(moduleRef.get(DbMigrationViewService)).toBeDefined();
    expect(moduleRef.get(DbPoolerCutService)).toBeDefined();
    expect(moduleRef.get(PoolerPauseSweeper)).toBeDefined();
  });
});

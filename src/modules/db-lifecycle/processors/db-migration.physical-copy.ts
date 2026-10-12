import { In } from 'typeorm';
import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import {
  NodeStatus,
  NodeType,
} from '../../infrastructure/clusters/entities/cluster-node.entity';
import { mirrorPoolerOptions } from '../../catalog/utils/catalog-options.util';
import { describeError } from '../../shared/utils/error.util';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import { PodPlacement } from '../services/db-pod-placement.service';
import {
  BASE_BACKUP_POLL_INTERVAL_MS,
  INSTALL_POLL_INTERVAL_MS,
  INSTALL_POLL_TIMEOUT_MS,
  INSTALL_TIMED_OUT,
  POSTGRESQL_SLUG,
  assertSameNodes,
  baseBackupTimeoutMs,
  resourcesOf,
} from '../utils/db-migration-run.core';
import {
  DbMigrationRunContext,
  DbMigrationState,
} from './db-migration.run-context';

/**
 * The physical path up to SYNCED: a standby destination, the link between
 * the two pods, and the copy streaming. Each step skips what an earlier
 * delivery already built.
 */
export class DbPhysicalCopy {
  constructor(
    private readonly ctx: DbMigrationRunContext,
    private readonly state: DbMigrationState,
  ) {}

  /** The destination is born a standby with the source's identity. */
  async provisionStandby(mig: DbMigrationEntity): Promise<void> {
    if (mig.status === DbMigrationStatus.REPLICATING && mig.dstInstallId) {
      return;
    }
    await this.state.enter(
      mig,
      [DbMigrationStatus.PENDING, DbMigrationStatus.PROVISIONING],
      DbMigrationStatus.PROVISIONING,
    );
    await this.state.setStep(
      mig,
      OperationStep.DB_MIGRATE_PROVISION_TARGET,
      10,
    );
    if (mig.dstInstallId) return;

    await this.ctx.placement.nodeOfApp(mig.srcAppId);
    const src = await this.ctx.exec.resolve(mig.srcAppId);
    const srcApp = await this.ctx.appRepo.findOne({
      where: { id: mig.srcAppId },
    });
    const triggeringUser = await this.ctx.userRepo.findOne({
      where: { id: mig.userId },
    });
    const { install } = await this.ctx.installer.install(
      POSTGRESQL_SLUG,
      {
        clusterId: mig.targetClusterId,
        displayName: mig.displayName,
        envOverrides: {
          POSTGRES_USER: src.pgUser,
          POSTGRES_DB: src.pgDb,
          FLUI_PG_STANDBY: '1',
        },
        allowMasterPlacement: await this.hasNoWorker(mig.targetClusterId),
        resourceOverrides: resourcesOf(srcApp),
        // The copy carries the source's pooler role; the destination's pooler
        // adopts its password before the standby starts.
        options: mirrorPoolerOptions(srcApp),
      },
      mig.userId,
      triggeringUser?.email,
    );
    mig.dstInstallId = install.id;
    await this.ctx.migRepo.update(mig.id, { dstInstallId: install.id });
  }

  async buildLink(mig: DbMigrationEntity): Promise<DbReplicationLinkEntity> {
    await this.state.setStep(mig, OperationStep.DB_MIGRATE_LINK, 20);
    const dst = await this.waitForDestinationPod(mig);
    if (mig.dstAppId !== dst.appId) {
      mig.dstAppId = dst.appId;
      await this.ctx.migRepo.update(mig.id, { dstAppId: dst.appId });
    }
    await this.adoptBeforePromote(mig, dst.appId);
    const src = await this.ctx.placement.nodeOfApp(mig.srcAppId);

    let link: DbReplicationLinkEntity;
    if (mig.linkId) {
      link = await this.ctx.physical.getLink(mig.linkId);
      assertSameNodes(link, src, dst);
    } else {
      link = await this.ctx.physical.createLink(mig.srcAppId, dst.appId, {
        srcNodeId: src.nodeId,
        dstNodeId: dst.nodeId,
      });
      mig.linkId = link.id;
      await this.ctx.migRepo.update(mig.id, { linkId: link.id });
    }
    await this.ctx.physical.openTransport(link, src, dst);
    await this.ctx.physical.checkCompatibility(link, { src, dst });
    await this.ctx.physical.assertRoomOnDestination(link);
    return link;
  }

  /**
   * A pooled source: the destination's pooler logs in with the source's
   * password and its URLs carry the source's credentials from the start, so
   * an app staged on the destination reads the standby through its pooler.
   * Without a pooler on the source nothing changes before promote.
   */
  private async adoptBeforePromote(
    mig: DbMigrationEntity,
    dstAppId: string,
  ): Promise<void> {
    const srcApp = await this.ctx.appRepo.findOne({
      where: { id: mig.srcAppId },
    });
    if (!srcApp?.pooler?.enabled) return;
    if (await this.ctx.handoff.adoptSourcePoolerAuth(mig.srcAppId, dstAppId)) {
      await this.ctx.poolers
        ?.applyObjects(dstAppId)
        .catch((err: unknown) =>
          this.ctx.logger.warn(
            `[db-migration] ${mig.id}: destination pooler not rolled with the source's password yet: ${describeError(err)}`,
          ),
        );
    }
    await this.ctx.handoff.adoptSourceIdentity(mig.srcAppId, dstAppId);
  }

  /**
   * Base backup, standby up, streaming, then the copy checks. The catalog
   * install may time out while a large copy runs: that is tolerated, and
   * repaired once the standby is up.
   */
  async copyAndStream(
    mig: DbMigrationEntity,
    link: DbReplicationLinkEntity,
  ): Promise<void> {
    await this.state.enter(
      mig,
      [DbMigrationStatus.PROVISIONING, DbMigrationStatus.REPLICATING],
      DbMigrationStatus.REPLICATING,
    );
    await this.state.setStep(mig, OperationStep.DB_MIGRATE_BASE_BACKUP, 35);
    if (!(await this.ctx.physical.standbyState(link)).done) {
      await this.ctx.physical.attachStandby(link);
    }
    const deadline = Date.now() + baseBackupTimeoutMs();
    for (;;) {
      await this.state.assertNotAborted(mig);
      const standby = await this.ctx.physical.standbyState(link);
      const view = await this.ctx.physical.status(link);
      if (
        standby.done &&
        standby.inRecovery === true &&
        view.state === 'streaming'
      ) {
        break;
      }
      if (standby.done && standby.inRecovery === false) {
        throw new Error(
          'The destination left recovery on its own — it is not a standby of the source',
        );
      }
      if (!standby.done) await this.assertInstallAlive(mig);
      if (Date.now() > deadline) {
        throw new Error(
          `The copy did not reach streaming in time (standby ${standby.done ? 'up' : 'copying'}, replication ${view.state ?? 'not connected'})`,
        );
      }
      await this.ctx.sleep(BASE_BACKUP_POLL_INTERVAL_MS);
    }
    await this.ctx.physical.verifyCopy(link);
    await this.ctx.physical.markStreaming(link);
    await this.repairTimedOutInstall(mig);
  }

  /** Best-effort: a failed run must not leave a link, a slot or a port open. */
  async teardownFailedLink(mig: DbMigrationEntity): Promise<string[]> {
    const linkId =
      mig.linkId ??
      (await this.ctx.migRepo.findOne({ where: { id: mig.id } }))?.linkId;
    if (!linkId) return [];
    try {
      const link = await this.ctx.physical.getLink(linkId);
      return (await this.ctx.physical.abort(link)).notes;
    } catch (err: any) {
      return [`link teardown failed: ${err?.message ?? err}`];
    }
  }

  private async waitForDestinationPod(
    mig: DbMigrationEntity,
  ): Promise<PodPlacement> {
    const deadline = Date.now() + INSTALL_POLL_TIMEOUT_MS;
    for (;;) {
      await this.state.assertNotAborted(mig);
      const install = await this.assertInstallAlive(mig);
      const appId = install.applicationIds?.[0];
      if (appId) {
        const placed = await this.ctx.placement.scheduled(appId);
        if (placed) return placed;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The destination pod of install ${install.id} was not running in time (install ${install.status})`,
        );
      }
      await this.ctx.sleep(INSTALL_POLL_INTERVAL_MS);
    }
  }

  /** A deploy timeout is expected while a large copy runs; anything else is not. */
  private async assertInstallAlive(
    mig: DbMigrationEntity,
  ): Promise<CatalogInstallEntity> {
    const install = await this.ctx.installRepo.findOne({
      where: { id: mig.dstInstallId },
    });
    if (!install) throw new Error(`Install ${mig.dstInstallId} vanished`);
    if (
      install.status === CatalogInstallStatus.FAILED &&
      !INSTALL_TIMED_OUT.test(install.errorMessage ?? '')
    ) {
      throw new Error(
        `Target install ${install.id} failed: ${install.errorMessage ?? 'unknown'}`,
      );
    }
    return install;
  }

  private async repairTimedOutInstall(mig: DbMigrationEntity): Promise<void> {
    const install = await this.ctx.installRepo.findOne({
      where: { id: mig.dstInstallId },
    });
    if (install?.status !== CatalogInstallStatus.FAILED) return;
    await this.ctx.installRepo.update(install.id, {
      status: CatalogInstallStatus.RUNNING,
      errorMessage: null as unknown as undefined,
    });
    this.ctx.logger.log(
      `[db-migration] ${mig.id}: install ${install.id} timed out during the copy; the standby is up, marked running`,
    );
  }

  private async hasNoWorker(clusterId: string): Promise<boolean> {
    const workers = await this.ctx.nodeRepo.count({
      where: {
        clusterId,
        nodeType: NodeType.WORKER,
        status: In([NodeStatus.READY, NodeStatus.JOINING, NodeStatus.CREATING]),
      },
    });
    return workers === 0;
  }
}

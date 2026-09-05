import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import { DestinationRole } from '../enums/destination-role.enum';

export type RestoredWith =
  | { kind: 'database'; from: string }
  | { kind: 'volume'; claim: string; from: string }
  | { kind: 'none'; why: string };

/**
 * Puts an application's data where the application will look for it, before it
 * looks — so a rebuilt application never starts empty and then gets filled.
 *
 * Lives in the backups module because that is where the artifacts, policies and
 * engines already are; the rebuild asks it one question and does not learn how
 * any of them work.
 */
@Injectable()
export class RebuildDataRestorer {
  private readonly logger = new Logger(RebuildDataRestorer.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    private readonly policyRepo: BackupPolicyRepository,
    private readonly artifactRepo: BackupArtifactRepository,
    private readonly destRepo: BackupDestinationRepository,
    private readonly engines: ContinuousBackupEngineRegistry,
  ) {}

  async restoreInto(
    app: ApplicationEntity,
    to: ClusterEntity,
  ): Promise<RestoredWith> {
    void to;
    const policy = await this.policyRepo.findDbPolicyForApp(app.id);
    if (policy) return this.prepareDatabase(app, policy);
    if ((app.volumes ?? []).length > 0) {
      return {
        kind: 'none',
        why: 'no volume copy has been taken, so it comes back empty',
      };
    }
    return { kind: 'none', why: 'nothing to restore' };
  }

  /**
   * Boots the rebuilt database in restore mode instead of filling it after.
   *
   * Both engines already recover into an empty data directory at first start,
   * driven by environment: Postgres when `PG_VERSION` is absent, MariaDB from
   * its init container. Writing that environment onto the row the deploy
   * renders from means the server's first start reads recovered data — there
   * is no window in which the application is up and empty.
   */
  private async prepareDatabase(
    app: ApplicationEntity,
    policy: { id: string; engine?: string | null },
  ): Promise<RestoredWith> {
    const artifact = await this.artifactRepo.findLatestDbArtifactForApp(app.id);
    if (!artifact) {
      return {
        kind: 'none',
        why: 'continuous backup is on but no base backup exists yet',
      };
    }
    const destinationId = artifact.locations?.find(
      (l) => l.role === DestinationRole.PRIMARY,
    )?.destinationId;
    const destination = destinationId
      ? await this.destRepo.findById(destinationId)
      : null;
    if (!destination) {
      return {
        kind: 'none',
        why: 'the backup has no destination to read from',
      };
    }

    const engine = this.engines.forEngine(artifact.engine ?? policy.engine);
    const restoreEnv = engine.buildRestoreEnv(
      app.id,
      destination,
      undefined,
      artifact.engineRef ?? undefined,
      (artifact.manifestSummary?.generation as string | undefined) ?? undefined,
    );

    // Onto the row, because the row is what the manifest is rendered from. The
    // catalog's declaration matters only at install; here the values are ours.
    const keep = (app.env ?? []).filter(
      (e) => !e.name.startsWith(engine.restoreEnvPrefix),
    );
    app.env = [
      ...keep,
      ...Object.entries(restoreEnv).map(([name, value]) => ({
        name,
        value,
        secret: /KEY|SECRET|PASSWORD/.test(name),
      })),
    ] as ApplicationEntity['env'];
    await this.appRepo.save(app);

    this.logger.log(
      `[rebuild] ${app.slug} will boot recovering ${artifact.engineRef} from ${destination.name}`,
    );
    return { kind: 'database', from: artifact.engineRef ?? artifact.id };
  }
}

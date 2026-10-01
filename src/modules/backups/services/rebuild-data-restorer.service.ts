import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { claimNameForVolume } from '../../applications/services/application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BackupPolicyRepository } from '../repositories/backup-policy.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupDestinationRepository } from '../repositories/backup-destination.repository';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { ContinuousBackupEngineRegistry } from './continuous-backup-engine.registry';
import { DestinationRole } from '../enums/destination-role.enum';
import { BackupDestinationsService } from './backup-destinations.service';
import {
  cryptEnv,
  isCryptSummary,
  restorePasswords,
} from '../utils/rclone-crypt.util';
import {
  KopiaS3Location,
  KopiaSnapshotRecord,
  kopiaLocation,
  kopiaRestorePassword,
} from '../utils/kopia-repository.util';
import {
  PodRestore,
  emptyDatabase,
  RESTORE_CRYPT_PREFIX,
  RestoredWith,
  clearRestoreDeclaration,
  databaseDumpOutcome,
  emptyPodRestore,
  noVolumeCopyReason,
  kopiaRestoreInitContainer,
  rcloneRestoreInitContainer,
  takenOn,
  volumeCopyRoute,
  withEngineRestoreEnv,
  withKopiaRestoreEnv,
  withRcloneRestoreEnv,
  withRestoreInits,
} from '../utils/rebuild-restore.util';

export type { RestoredWith } from '../utils/rebuild-restore.util';

/**
 * Declares the recovery on the application row so the workload is born reading
 * it: a database boots recovering, a volume is filled by an init container
 * before the application's container may start.
 *
 * A Job filling a claim the deploy then adopts was rejected: it would bind the
 * volume to its own node while the deploy picks another, leaving the pod
 * Pending forever on a node-affinity conflict. One pod is one node.
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
    private readonly encryption: EncryptionService,
    private readonly destinations: BackupDestinationsService,
  ) {}

  /**
   * A list rather than a verdict: an application can be a database with an
   * uploads directory beside it, and one answer hides whichever half failed.
   */
  async restoreInto(
    app: ApplicationEntity,
    _to: ClusterEntity,
  ): Promise<RestoredWith[]> {
    this.clearPreviousAttempt(app);
    const outcomes = await this.decide(app, false);
    await this.appRepo.save(app);
    return outcomes;
  }

  /** The same decision without writing anything, so the plan cannot drift
   * from what the rebuild does. */
  async preview(app: ApplicationEntity): Promise<RestoredWith[]> {
    return this.decide(app, true);
  }

  private async decide(
    app: ApplicationEntity,
    dryRun: boolean,
  ): Promise<RestoredWith[]> {
    const outcomes: RestoredWith[] = [];
    const database = await this.prepareDatabase(app, dryRun);
    if (database) outcomes.push(database);
    outcomes.push(
      ...(await this.prepareVolumes(app, database !== null, dryRun)),
    );
    return outcomes;
  }

  /**
   * Puts the rebuilt database back under the protection its policy claims.
   *
   * The image neutralises `archive_command` after a restore — the restored
   * config names a file that did not come with it — expecting whoever enables
   * backup to write the real one. A rebuild never enables: it moves the policy
   * row and stops. So the database came back with `archive_mode on` and
   * `archive_command '/bin/true'`, and `pg_stat_archiver` reported success with
   * zero failures while every segment was discarded, under a policy that read
   * enabled and active. Measured 13 hours after a rebuild.
   *
   * Re-arming alone is not enough: the segments already thrown away are
   * recycled, so the old base plus its logs cannot reach any moment after the
   * rebuild. A base taken now is what closes that.
   */
  async rearm(
    applicationId: string,
  ): Promise<{ policyId: string; continuous: boolean } | null> {
    // On existence, not on `enabled`: pausing a database policy is defined as
    // "keep shipping WAL, stop taking bases", so a paused one still ships.
    const policy = await this.policyRepo.findDbPolicyForApp(applicationId);
    if (!policy) return null;

    const destination = await this.destinationOf(policy.destinations);
    if (!destination) {
      throw new Error(
        'the backup policy has no destination Flui holds credentials for, so ' +
          'WAL shipping cannot be re-armed and this database is not protected',
      );
    }

    const engine = this.engines.forEngine(policy.engine);
    await engine.awaitWritable?.(applicationId);

    // A new one, never the old: the rebuilt server restarts its log numbering,
    // so writing into the previous prefix overwrites files the earlier bases
    // point into and makes every one of them unrestorable, silently. Persisted
    // first — the scheduled run reads it from here, and would otherwise re-arm
    // tomorrow with the generation this call replaced.
    const generation = engine.mintGeneration?.();
    if (generation) {
      await this.policyRepo.update(policy.id, {
        metadata: { ...policy.metadata, generation },
      });
    }

    await engine.enable(applicationId, destination, {
      retentionFull: policy.retentionMaxCopies ?? 2,
      generation:
        generation ?? (policy.metadata?.generation as string | undefined),
    });
    const continuous = engine.pointInTime !== false;
    this.logger.log(
      `[rebuild] ${applicationId}: ${continuous ? 'WAL shipping re-armed' : 'scheduled dumps re-armed'}`,
    );
    return { policyId: policy.id, continuous };
  }

  /**
   * Loads the newest dump into the rebuilt database, which boots empty: a dump
   * goes in through the running server, so no environment on the row can do it
   * at first start. Null when the database is restored at boot instead, or
   * when there is nothing to load — `restoreInto` has already said why.
   */
  async loadDump(applicationId: string): Promise<string | null> {
    const policy = await this.policyRepo.findDbPolicyForApp(applicationId);
    if (!policy) return null;
    const artifact =
      await this.artifactRepo.findLatestDbArtifactForApp(applicationId);
    if (!artifact) return null;
    const engine = this.engines.forEngine(artifact.engine ?? policy.engine);
    if (!engine.loadIntoRestored) return null;
    const destination = await this.destinationOf(artifact.locations);
    if (!destination) return null;
    if (!artifact.engineRef) {
      throw new Error(
        'the newest dump does not name the object it was written to, so the ' +
          'database is running empty',
      );
    }

    await engine.awaitWritable?.(applicationId);
    try {
      await engine.loadIntoRestored(applicationId, {
        sourceAppId: applicationId,
        engineRef: artifact.engineRef,
        destination,
      });
    } catch (err) {
      throw new Error(
        `the dump ${artifact.engineRef} could not be loaded, so the database ` +
          `is running without it: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.log(
      `[rebuild] ${applicationId}: loaded the dump ${artifact.engineRef}`,
    );
    return (
      `database: loaded the dump ${artifact.engineRef}; anything written ` +
      'after it was taken is not in it'
    );
  }

  /**
   * Otherwise a live credential for someone else's repository stays in the
   * application's environment for as long as it exists. The running pod is
   * untouched; the next deploy renders clean.
   */
  async forget(applicationId: string): Promise<void> {
    const app = await this.appRepo.findOne({ where: { id: applicationId } });
    if (!app) return;
    if (!this.clearPreviousAttempt(app)) return;
    await this.appRepo.save(app);
    this.logger.log(`[rebuild] ${app.slug}: restore declaration removed`);
  }

  /** True when there was something to remove. */
  private clearPreviousAttempt(app: ApplicationEntity): boolean {
    return clearRestoreDeclaration(
      app,
      this.engines.all().map((e) => e.restoreEnvPrefix),
    );
  }

  /**
   * The continuous engines recover into an empty data directory at first
   * start, driven by environment, so writing it on the row leaves no window in
   * which the application is up and empty. A dump is loaded after the deploy,
   * by `loadDump`. Null when the database has no backup policy.
   */
  private async prepareDatabase(
    app: ApplicationEntity,
    dryRun: boolean,
  ): Promise<RestoredWith | null> {
    const policy = await this.policyRepo.findDbPolicyForApp(app.id);
    if (!policy) return null;

    const artifact = await this.artifactRepo.findLatestDbArtifactForApp(app.id);
    if (!artifact) {
      return emptyDatabase(
        'continuous backup is on but no base backup exists yet',
      );
    }
    const destination = await this.destinationOf(artifact.locations);
    if (!destination) {
      return emptyDatabase(
        'the backup has no destination Flui holds credentials for',
      );
    }

    const engine = this.engines.forEngine(artifact.engine ?? policy.engine);
    if (engine.loadIntoRestored) {
      return databaseDumpOutcome(artifact.engineRef);
    }
    // Neither instant nor label: both engines read the absence as "newest
    // base, then every log after it". Naming the label pinned recovery to when
    // that backup was taken — measured at 3h51m of WAL discarded, silently.
    const restoreEnv = engine.buildRestoreEnv(
      app.id,
      destination,
      undefined,
      undefined,
      (artifact.manifestSummary?.generation as string | undefined) ?? undefined,
      artifact.manifestSummary,
    );
    const from = `${artifact.engineRef ?? artifact.id} and every log archived after it`;

    if (dryRun) {
      return { kind: 'database', what: 'database', from };
    }

    app.env = withEngineRestoreEnv(
      app.env,
      engine.restoreEnvPrefix,
      restoreEnv,
    );

    return { kind: 'database', what: 'database', from };
  }

  /**
   * One init container per volume with a copy, a stated reason for the rest.
   *
   * The newest copy still stored wins, whichever engine made it: a kopia
   * snapshot is restored by kopia, an rclone archive from before kopia by
   * rclone, each in the pod that will use the volume.
   */
  private async prepareVolumes(
    app: ApplicationEntity,
    databaseHandled: boolean,
    dryRun: boolean,
  ): Promise<RestoredWith[]> {
    const volumes = app.volumes ?? [];
    if (volumes.length === 0) return [];

    const pod = emptyPodRestore();
    const outcomes: RestoredWith[] = [];
    for (const volume of volumes) {
      outcomes.push(
        await this.prepareVolume(
          app,
          volume.name,
          claimNameForVolume(app, volume),
          databaseHandled,
          pod,
        ),
      );
    }

    if (dryRun || !pod.credentials || pod.inits.length === 0) return outcomes;
    // The archive variables first: declaring them clears every restore
    // variable, the kopia ones included.
    if (pod.anyArchive) {
      this.declareRclone(app, pod.credentials, pod.anyEncrypted);
    }
    if (pod.kopiaPassword) {
      this.declareKopia(app, pod.credentials, pod.kopiaPassword);
    }
    app.companions = withRestoreInits(
      app.companions,
      pod.inits,
      !!pod.kopiaPassword,
    );
    return outcomes;
  }

  /**
   * One volume. The claim is the name the ledger recorded the copy under: the
   * copy names the live PVC, and this is the rule that produced it on the
   * lost cluster.
   */
  private async prepareVolume(
    app: ApplicationEntity,
    volumeName: string,
    claim: string,
    databaseHandled: boolean,
    pod: PodRestore,
  ): Promise<RestoredWith> {
    const empty = (why: string): RestoredWith => ({
      kind: 'empty',
      what: volumeName,
      why,
    });
    const artifact = await this.artifactRepo.findLatestVolumeCopyForApp(
      app.id,
      claim,
    );
    if (!artifact) return empty(noVolumeCopyReason(databaseHandled));

    const copy = volumeCopyRoute(artifact, databaseHandled);
    if ('refused' in copy) return empty(copy.refused);
    const destination = await this.destinationOf(artifact.locations);
    if (!destination) {
      return empty(
        'a copy exists but Flui holds no credentials for its bucket',
      );
    }
    const { route, prefix } = copy;
    if (route.kind === 's3-archive' && !prefix) {
      return empty('the copy was recorded without the path it was written to');
    }
    pod.credentials ??= destination;
    if (destination.id !== pod.credentials.id) {
      // One set of storage variables serves the whole pod, so a second
      // bucket would be read with the first's credentials.
      return empty(
        'its copy is in a different destination from another volume of the same application',
      );
    }

    if (route.kind === 's3-archive') {
      const encrypted = isCryptSummary(artifact.manifestSummary);
      pod.anyEncrypted ||= encrypted;
      pod.anyArchive = true;
      pod.inits.push(
        rcloneRestoreInitContainer(app, volumeName, prefix!, encrypted),
      );
      return { kind: 'volume', what: volumeName, from: prefix! };
    }
    return this.prepareKopiaVolume(
      app,
      volumeName,
      destination,
      route.record,
      artifact.createdAt,
      pod,
    );
  }

  private prepareKopiaVolume(
    app: ApplicationEntity,
    volumeName: string,
    destination: BackupDestinationEntity,
    record: KopiaSnapshotRecord,
    createdAt: Date,
    pod: PodRestore,
  ): RestoredWith {
    let location: KopiaS3Location;
    try {
      pod.kopiaPassword ??= kopiaRestorePassword(
        this.destinations.decryptPassphrase(destination),
        app.id,
        destination.name,
      );
      location = kopiaLocation(destination, app.id);
    } catch (err) {
      return {
        kind: 'empty',
        what: volumeName,
        why: err instanceof Error ? err.message : String(err),
      };
    }
    pod.inits.push(
      kopiaRestoreInitContainer(volumeName, location, app.id, record),
    );
    return {
      kind: 'volume',
      what: volumeName,
      from: `the kopia snapshot ${record.snapshotId}${takenOn(createdAt)}`,
    };
  }

  private declareKopia(
    app: ApplicationEntity,
    destination: BackupDestinationEntity,
    password: string,
  ): void {
    app.env = withKopiaRestoreEnv(
      app.env,
      password,
      this.encryption.decrypt(destination.accessKeyEncrypted),
      this.encryption.decrypt(destination.secretKeyEncrypted),
    );
  }

  /** From the environment, so the secret half lands in the application's
   * Secret rather than in the pod spec. */
  private declareRclone(
    app: ApplicationEntity,
    destination: BackupDestinationEntity,
    encrypted: boolean,
  ): void {
    const accessKey = this.encryption.decrypt(destination.accessKeyEncrypted);
    const secretKey = this.encryption.decrypt(destination.secretKeyEncrypted);
    app.env = withRcloneRestoreEnv(
      app.env,
      destination,
      accessKey,
      secretKey,
      encrypted
        ? cryptEnv(
            restorePasswords(
              this.destinations.decryptPassphrase(destination),
              destination.name,
            ),
            RESTORE_CRYPT_PREFIX,
          )
        : null,
    );
  }

  private async destinationOf(
    locations: Array<{ role: string; destinationId?: string }> | undefined,
  ): Promise<BackupDestinationEntity | null> {
    const id = locations?.find(
      (l) => l.role === DestinationRole.PRIMARY,
    )?.destinationId;
    return id ? await this.destRepo.findById(id) : null;
  }
}

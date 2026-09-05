import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import {
  ArtifactEngineFacts,
  ContinuousBackupEngine,
} from './continuous-backup-engine.interface';
import { RestoreStrategy } from '../enums/restore-job.enum';
import {
  MariadbTarget,
  SHIPPER_CONFIG_KEY,
  SHIPPER_CONFIG_PATH,
  SHIPPER_CONFIG_POLL_MS,
  SHIPPER_CONFIG_WAIT_MS,
  SHIPPER_CONTAINER,
  SHIPPER_SECRET_SUFFIX,
  artifactObjectKeys,
  artifactObjectPrefix,
  buildRestoreEnv,
  identityEnv,
  mintGeneration,
} from './mariadb-pitr.util';

/**
 * Continuous backup for MariaDB: a base backup plus its binary logs.
 *
 * It differs from Postgres in one way that shapes everything here: MariaDB has
 * no `archive_command`. Postgres hands each finished segment to a command of
 * Flui's choosing, so shipping is the database's own job. MariaDB writes its
 * binary logs and forgets about them, so something has to be alive and reading
 * continuously — which is why this engine needs a companion process where
 * pgBackRest needed only a config file.
 *
 * Credentials follow the rule established with the Redis hook: every command
 * runs inside the workload's own container and authenticates from the
 * environment that container already has. Flui supplies object-storage
 * credentials and never an engine password.
 */
@Injectable()
export class MariadbPitrService implements ContinuousBackupEngine {
  private readonly logger = new Logger(MariadbPitrService.name);

  readonly engine = 'mariadb';
  readonly catalogSlug = 'mariadb';
  readonly restoreEnvPrefix = 'FLUI_MARIADB_';
  readonly restoreStrategy = RestoreStrategy.MARIADB_PITR;
  readonly selfPrunesRepository = false;

  constructor(
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
  ) {}

  private envValue(app: ApplicationEntity, name: string): string | undefined {
    return app.env?.find((e) => e.name === name)?.value;
  }

  async resolveTarget(appId: string): Promise<MariadbTarget> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    }
    return {
      kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
      namespace: app.k8sNamespace,
      labelSelector: `flui-app-id=${app.id}`,
      container: app.slug,
      host: '127.0.0.1',
      port: 3306,
      rootPasswordVar: 'MARIADB_ROOT_PASSWORD',
      user: this.envValue(app, 'MARIADB_USER') ?? 'root',
      database: this.envValue(app, 'MARIADB_DATABASE') ?? 'mysql',
    };
  }

  /**
   * Runs a script in the shipper rather than the database.
   *
   * Asks the pod spec whether the shipper is there before trying, rather than
   * reading the failure afterwards: an exec into a container that does not
   * exist fails on the websocket upgrade, and what reaches this catch may be
   * the API server's `container X is not valid for pod Y` or a bare `400`
   * depending on how far the transport got. A scheduled base backup can arrive
   * here long after the policy was created, on an application that has since
   * been redeployed without one.
   */
  private async execInShipper(
    target: MariadbTarget,
    script: string,
  ): Promise<string> {
    if ((await this.shipperPresent(target)) === false) {
      throw new BadRequestException(
        'This MariaDB has no backup shipper alongside it, so it cannot take a ' +
          'base backup. Its binary logs are still being written and are still ' +
          'being retained, so nothing has been lost yet — but nothing is ' +
          'carrying them off the cluster either.',
      );
    }
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    return this.k8s.execInPod(
      target.kubeconfig,
      target.namespace,
      target.labelSelector,
      SHIPPER_CONTAINER,
      // `bash`, not `sh`: the image's /bin/sh is dash, which rejects
      // `set -o pipefail` outright — the script would die on its first line
      // and every command after it would silently not run.
      ['bash', '-c', `echo ${b64} | base64 -d | bash`],
    );
  }

  private async exec(target: MariadbTarget, script: string): Promise<string> {
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    return this.k8s.execInPod(
      target.kubeconfig,
      target.namespace,
      target.labelSelector,
      target.container,
      ['sh', '-c', `echo ${b64} | base64 -d | sh`],
    );
  }

  /** A `mariadb` invocation that authenticates from the container's own env. */
  private client(target: MariadbTarget): string {
    return `mariadb -uroot -p"$${target.rootPasswordVar}" -N -B`;
  }

  private async query(
    target: MariadbTarget,
    sql: string,
  ): Promise<string | undefined> {
    try {
      const out = await this.exec(
        target,
        `${this.client(target)} -e ${JSON.stringify(sql)}`,
      );
      return out.trim().split('\n').pop()?.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Is the shipper alongside this database, read from the pod's own spec?
   *
   * From the spec rather than from a failed exec into it, because an exec into
   * a container that does not exist fails on the websocket upgrade — the API
   * server answers `container X is not valid for pod Y`, which no amount of
   * pattern-matching turns into a reliable signal, and the transport can turn
   * it into a bare `400` before the body is ever read.
   *
   * `undefined` when no pod could be listed, which is not the same as "no
   * shipper": `listResourcesByLabel` returns `[]` for an unreachable cluster
   * too, and refusing a database because its cluster was briefly unreachable
   * would be a refusal for the wrong reason.
   */
  private async shipperPresent(
    target: MariadbTarget,
  ): Promise<boolean | undefined> {
    const pods = await this.k8s.listResourcesByLabel(
      target.kubeconfig,
      'Pod',
      target.namespace,
      target.labelSelector,
    );
    if (!pods.length) return undefined;
    return pods.some((pod: any) =>
      (pod?.spec?.containers ?? []).some(
        (c: any) => c?.name === SHIPPER_CONTAINER,
      ),
    );
  }

  /**
   * Refuse before touching anything, and say which thing is wrong.
   *
   * The four failures need four different fixes and one message would send
   * people to the wrong one: a stopped database is started, a missing binary
   * means the wrong image, an absent shipper means the pod predates it, and
   * `log_bin = OFF` means a restart — which is why the catalog seed turns it
   * on at birth, so that branch is reached only by instances that predate it.
   *
   * The shipper is checked first among the pod-shaped failures. Its absence is
   * not fixed by starting the database, so reporting a stopped pod would send
   * someone to an action that changes nothing.
   */
  async requireTooling(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);

    if ((await this.shipperPresent(target)) === false) {
      throw new BadRequestException(
        'This MariaDB has no backup shipper alongside it, so nothing would ' +
          'carry its binary logs off the cluster. MariaDB cannot hand a ' +
          'finished log to a command of its own the way Postgres does, so the ' +
          'shipper is not optional: enabling a policy without one would record ' +
          'protection that does not exist, and stop the database purging its ' +
          'own logs while nothing collected them. A database gets its shipper ' +
          'when it is installed from a catalog that provides one.',
      );
    }

    let tools: string;
    try {
      tools = await this.exec(
        target,
        'for t in mariadb-backup mariadb-binlog mariadb; do ' +
          'command -v "$t" >/dev/null 2>&1 || { echo "MISSING:$t"; exit 0; }; ' +
          'done; echo OK',
      );
    } catch (err: any) {
      if (/No running pod/i.test(err?.message ?? '')) {
        throw new BadRequestException(
          'This database is not running, so continuous backup cannot be set ' +
            'up on it. Start it and try again.',
        );
      }
      throw err;
    }
    const missing = /MISSING:(\S+)/.exec(tools);
    if (missing) {
      throw new BadRequestException(
        `This database cannot do continuous backup: its image does not ship ` +
          `${missing[1]}. Continuous backup needs a MariaDB installed from the ` +
          'Flui catalog. For a database running from another image, take ' +
          'backups of its volume instead.',
      );
    }

    const logBin = await this.query(target, 'SELECT @@log_bin');
    if (logBin !== '1') {
      throw new BadRequestException(
        'This MariaDB was created before Flui enabled binary logging, and ' +
          '`log_bin` cannot be turned on while the server runs. Redeploy the ' +
          'application to pick up the current configuration — it restarts the ' +
          'database — and then enable continuous backup.',
      );
    }
  }

  /**
   * Make the server ready to be backed up, and prove it before anything is
   * recorded.
   *
   * Three settings, all dynamic, all reversed by {@link disable}:
   *
   * `binlog_format = ROW` because statement replay can diverge on
   * non-deterministic statements, and that failure looks like a successful
   * restore holding subtly wrong data.
   *
   * `sync_binlog = 1` because the default lets a host crash lose committed
   * transactions from the binary log that InnoDB has already kept — the
   * recovery window would then be missing writes the database itself still has.
   *
   * `binlog_expire_logs_seconds = 0` because the server's own ten-day purge
   * knows nothing about what has been shipped. With it at zero the disk fills
   * if shipping stalls, which is loud; with it left alone the recovery window
   * silently develops a hole that is discovered during a restore.
   */
  async enable(
    appId: string,
    destination: BackupDestinationEntity,
    opts?: { retentionFull?: number; generation?: string },
  ): Promise<void> {
    await this.requireTooling(appId);
    const target = await this.resolveTarget(appId);
    await this.writeShipperConfig(appId, target, destination, opts?.generation);
    await this.exec(
      target,
      [
        'set -e',
        `${this.client(target)} -e "SET GLOBAL binlog_format = 'ROW'"`,
        `${this.client(target)} -e "SET GLOBAL sync_binlog = 1"`,
        `${this.client(target)} -e "SET GLOBAL binlog_expire_logs_seconds = 0"`,
        `${this.client(target)} -e "FLUSH BINARY LOGS"`,
      ].join('\n'),
    );
    this.logger.log(
      `[mariadb-pitr] prepared app=${appId} for continuous backup`,
    );
  }

  /**
   * Hand the server back its own defaults.
   *
   * Not optional cleanup. Leaving `binlog_expire_logs_seconds = 0` behind means
   * a database that never purges its binary logs again, and the volume fills —
   * an outage of the source, caused by a backup that was deleted.
   */
  async disable(appId: string): Promise<void> {
    const target = await this.resolveTarget(appId);
    // The destination goes first. Handing the server back its own expiry while
    // a shipper is still pointed at a repository nothing manages would let it
    // purge logs that are still being collected for a policy that no longer
    // exists.
    await this.k8s
      .deleteResource(
        target.kubeconfig,
        'Secret',
        `${target.container}${SHIPPER_SECRET_SUFFIX}`,
        target.namespace,
      )
      .catch((err: any) =>
        this.logger.warn(
          `[mariadb-pitr] could not remove the shipper destination for app=${appId}: ${err?.message}`,
        ),
      );
    await this.exec(
      target,
      [
        `${this.client(target)} -e "SET GLOBAL binlog_expire_logs_seconds = 864000" || true`,
        `${this.client(target)} -e "SET GLOBAL sync_binlog = 0" || true`,
      ].join('\n'),
    );
    this.logger.log(`[mariadb-pitr] released app=${appId}`);
  }

  /**
   * Hands the shipper its destination, credentials included, as one file.
   *
   * The whole destination travels in the Secret rather than in the pod spec:
   * `ship.sh` sources the file, so the exported rclone settings reach the
   * child process, and no object-storage credential ever appears in a manifest
   * or in the application's own environment.
   *
   * `FLUI_CONFIG_COMPLETE` is written last and checked by the reader. kubelet
   * swaps the whole directory atomically, so a half-written file should be
   * impossible — which is exactly why the sentinel is cheap to keep and would
   * have been expensive to assume.
   */
  private async writeShipperConfig(
    appId: string,
    target: MariadbTarget,
    dest: BackupDestinationEntity,
    generation?: string,
  ): Promise<void> {
    const prefix = (dest.pathPrefix ?? '').replace(/^\/+|\/+$/g, '');
    const remote = `flui:${dest.bucket}/${prefix ? prefix + '/' : ''}${this.artifactObjectPrefix(appId, generation).replace(/\/$/, '')}`;
    const config = [
      `export FLUI_S3_REMOTE=${JSON.stringify(remote)}`,
      `export FLUI_APP_ID=${JSON.stringify(appId)}`,
      'export RCLONE_CONFIG_FLUI_TYPE=s3',
      'export RCLONE_CONFIG_FLUI_PROVIDER=Other',
      `export RCLONE_CONFIG_FLUI_ACCESS_KEY_ID=${JSON.stringify(this.encryption.decrypt(dest.accessKeyEncrypted))}`,
      `export RCLONE_CONFIG_FLUI_SECRET_ACCESS_KEY=${JSON.stringify(this.encryption.decrypt(dest.secretKeyEncrypted))}`,
      `export RCLONE_CONFIG_FLUI_ENDPOINT=${JSON.stringify(dest.endpoint)}`,
      `export RCLONE_CONFIG_FLUI_REGION=${JSON.stringify(dest.region || 'auto')}`,
      `export RCLONE_CONFIG_FLUI_FORCE_PATH_STYLE=${dest.forcePathStyle ? 'true' : 'false'}`,
      'export FLUI_CONFIG_VERSION=1',
      'export FLUI_CONFIG_COMPLETE=1',
      '',
    ].join('\n');

    const name = `${target.container}${SHIPPER_SECRET_SUFFIX}`;
    await this.k8s.applyManifest(
      target.kubeconfig,
      [
        'apiVersion: v1',
        'kind: Secret',
        'metadata:',
        `  name: ${name}`,
        `  namespace: ${target.namespace}`,
        '  labels:',
        // Labelled so the application's teardown sweep takes it with the rest.
        `    flui-app-id: ${appId}`,
        '  annotations: {}',
        'type: Opaque',
        'data:',
        `  ${SHIPPER_CONFIG_KEY}: ${Buffer.from(config, 'utf-8').toString('base64')}`,
        '',
      ].join('\n'),
    );
    this.logger.log(
      `[mariadb-pitr] destination handed to the shipper for app=${appId}; ` +
        'it is picked up on the next kubelet sync, typically within a minute',
    );
  }

  /**
   * Wait until the shipper can actually see its destination.
   *
   * Not in `enable()`: the request that turns a policy on is synchronous and
   * the CLI gives it thirty seconds, while a mounted Secret takes about a
   * minute to appear. The first base backup is the right place to wait,
   * because it is the step that needs the file — and `enable` and
   * `recoverable` only become the same moment once it has run.
   */
  private async awaitShipperConfig(target: MariadbTarget): Promise<void> {
    const deadline = Date.now() + SHIPPER_CONFIG_WAIT_MS;
    for (;;) {
      const seen = await this.execInShipper(
        target,
        `test -r ${SHIPPER_CONFIG_PATH} && echo FLUI_CONFIG_PRESENT || echo FLUI_CONFIG_ABSENT`,
      ).catch(() => '');
      if (seen.includes('FLUI_CONFIG_PRESENT')) return;
      if (Date.now() > deadline) {
        throw new BadRequestException(
          'The backup destination has not reached the shipper yet. Kubernetes ' +
            'delivers a mounted secret on its sync loop, usually within a ' +
            'minute; nothing is wrong with the database, and the next ' +
            'scheduled run will take the first base backup.',
        );
      }
      await new Promise((r) => setTimeout(r, SHIPPER_CONFIG_POLL_MS));
    }
  }

  async describeForArtifact(appId: string): Promise<ArtifactEngineFacts> {
    const target = await this.resolveTarget(appId);
    return {
      engine: this.engine,
      engineVersion: await this.query(target, 'SELECT VERSION()'),
      tool: 'mariadb-backup',
      toolVersion: (
        await this.exec(
          target,
          'mariadb-backup --version 2>&1 | head -1',
        ).catch(() => '')
      )
        .trim()
        .slice(0, 32),
      catalogSlug: this.catalogSlug,
      identities: { user: target.user, database: target.database },
      position: {
        gtid: (await this.query(target, 'SELECT @@gtid_binlog_pos')) ?? '',
      },
    };
  }

  /**
   * Takes a base backup and streams it straight to object storage.
   *
   * Run in the shipper container rather than the database's own, and that is
   * the point: the official MariaDB image has no way to talk to S3 — no rclone,
   * no curl, not even wget — so a base backup taken there would have to land on
   * the data volume first, doubling the space the database needs at the exact
   * moment it is being protected. The shipper mounts the same volume and has
   * both tools, so the backup never touches disk twice.
   *
   * The position it ends at is captured with it. Without that, the binary logs
   * are a pile of files with no declared point to start replaying from.
   */
  async baseBackup(appId: string): Promise<string> {
    const target = await this.resolveTarget(appId);
    await this.awaitShipperConfig(target);
    const label = `base-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`;
    const out = await this.execInShipper(
      target,
      [
        'set -euo pipefail',
        '. /etc/flui/shipper/config',
        `LABEL="${label}"`,
        // Both halves live under one per-application prefix, so a single
        // `objectKeyPrefix` on the artifact location covers the base and the
        // logs that bring it forward — and deleting one deletes the pair.
        'DEST="$FLUI_S3_REMOTE/base/$LABEL"',
        // `--stream` writes to stdout, so nothing lands on the data volume.
        'mariadb-backup --backup --stream=mbstream ' +
          `--host=${target.host} --port=${target.port} ` +
          '--user=root --password="$MARIADB_ROOT_PASSWORD" ' +
          '2>/tmp/backup.log | rclone rcat "$DEST/base.mbstream" --s3-no-check-bucket',
        // The position the logs have to be replayed from. It travels INSIDE
        // the base as `mariadb_backup_binlog_info`, which is what a restore
        // reads — a sibling object could drift from the base it describes.
        // This copy exists only so the shipper can learn its purge floor
        // without pulling a multi-gigabyte stream to read three fields, and it
        // is written in the same tab-separated format as the in-base file so
        // there is one format to parse and not two.
        'POS=$(grep -oE "filename .([^\x27]+)., position .([0-9]+)., GTID of the last change .([^\x27]*)." /tmp/backup.log | tail -1)',
        'FILE=$(echo "$POS" | sed -E "s/.*filename \x27([^\x27]+)\x27.*/\\1/")',
        'POSN=$(echo "$POS" | sed -E "s/.*position \x27([0-9]+)\x27.*/\\1/")',
        'GTID=$(echo "$POS" | sed -E "s/.*change \x27([^\x27]*)\x27.*/\\1/")',
        'printf "%s\\t%s\\t%s\\n" "$FILE" "$POSN" "$GTID" | rclone rcat "$DEST/binlog_info" --s3-no-check-bucket',
        'echo "FLUI_BASE_OK=$LABEL POS=$FILE:$POSN"',
      ].join('\n'),
    );
    if (!out.includes('FLUI_BASE_OK')) {
      throw new BadRequestException(
        'The base backup did not complete, so no restore point was created. ' +
          "Check the shipper container's logs.",
      );
    }
    this.logger.log(`[mariadb-pitr] base backup ${label} for app=${appId}`);
    return label;
  }

  /**
   * The window read from what actually reached object storage, never from the
   * server.
   *
   * The server knows what it wrote; only the repository knows what survived a
   * loss of the cluster, and that is the window a recovery can actually use.
   */
  async info(appId: string): Promise<{
    latestLabel: string | null;
    oldestRecoverable: string | null;
    newestRecoverable: string | null;
    backupCount: number;
  }> {
    const target = await this.resolveTarget(appId);
    const out = await this.execInShipper(
      target,
      [
        'export TZ=UTC',
        '. /etc/flui/shipper/config 2>/dev/null || exit 0',
        // Times, not names. The window a person is shown has to be made of
        // moments: a base label truncated to a column width reads like a date
        // and is not one, and `Date.parse` on it yields NaN, so every check
        // written against the window silently stops being a check.
        'echo "BASES=$(rclone lsf --format tp -R "$FLUI_S3_REMOTE/base/" 2>/dev/null | grep "/binlog_info$" | sort | tr "\n" " ")"',
        'echo "LOGS=$(rclone lsf --format tp "$FLUI_S3_REMOTE/binlog/" 2>/dev/null | sort -t";" -k2 | tr "\n" " ")"',
      ].join('\n'),
    ).catch(() => '');

    // Each entry is `YYYY-MM-DD HH:MM:SS;path`.
    const parse = (line: string | undefined) =>
      (line ?? '')
        .trim()
        .split(/\s(?=\d{4}-)/)
        .map((e) => e.trim())
        .filter(Boolean)
        .map((e) => {
          const [when, ...rest] = e.split(';');
          return { at: when, path: rest.join(';') };
        });

    const bases = parse(/BASES=(.*)/.exec(out)?.[1]);
    const logs = parse(/LOGS=(.*)/.exec(out)?.[1]);
    const iso = (when: string | undefined) =>
      when ? `${when.trim().replace(' ', 'T')}Z` : null;

    return {
      backupCount: bases.length,
      latestLabel: bases.at(-1)?.path.replace(/\/binlog_info$/, '') ?? null,
      // A base with no logs after it is a single point, not a window; a log
      // with no base before it cannot be replayed onto anything.
      oldestRecoverable: bases.length && logs.length ? iso(bases[0].at) : null,
      newestRecoverable:
        bases.length && logs.length ? iso(logs.at(-1)?.at) : null,
    };
  }

  /** See {@link artifactObjectPrefix} in `mariadb-pitr.util.ts` for the why. */
  artifactObjectPrefix(appId: string, generation?: string): string {
    return artifactObjectPrefix(appId, generation);
  }

  /** See {@link mintGeneration} in `mariadb-pitr.util.ts` for the why. */
  mintGeneration(): string {
    return mintGeneration();
  }

  /** See {@link artifactObjectKeys} in `mariadb-pitr.util.ts` for the why. */
  artifactObjectKeys(
    appId: string,
    engineRef: string,
    generation?: string,
  ): string[] {
    return artifactObjectKeys(appId, engineRef, generation);
  }

  /** See {@link identityEnv} in `mariadb-pitr.util.ts` for the why. */
  identityEnv(identities: {
    user: string;
    database: string;
  }): Record<string, string> {
    return identityEnv(identities);
  }

  /** See {@link buildRestoreEnv} in `mariadb-pitr.util.ts` for the why. */
  buildRestoreEnv(
    sourceAppId: string,
    dest: BackupDestinationEntity,
    recoveryTargetTime?: Date | null,
    restoreSet?: string | null,
    generation?: string | null,
  ): Record<string, string> {
    return buildRestoreEnv(
      sourceAppId,
      dest,
      this.encryption.decrypt(dest.accessKeyEncrypted),
      this.encryption.decrypt(dest.secretKeyEncrypted),
      recoveryTargetTime,
      restoreSet,
      generation,
    );
  }
}

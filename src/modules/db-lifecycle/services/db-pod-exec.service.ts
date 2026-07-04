import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Readable } from 'node:stream';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { DEFAULT_PGDATA } from '../constants';

export interface ResolvedApp {
  appId: string;
  clusterId: string;
  kubeconfig: string;
  namespace: string;
  labelSelector: string;
  container: string;
  pgUser: string;
  pgDb: string;
  slug: string;
  svcHost: string;
  pvcRoot: string;
}

/**
 * Resolves an install to its pod-exec coordinates and runs psql/shell inside
 * the pod (app superuser via the image's local-socket trust) over the stored
 * kubeconfig — no port-forward, works on any cluster.
 */
@Injectable()
export class DbPodExecService {
  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  envValue(app: ApplicationEntity, name: string): string | undefined {
    return app.env?.find((e) => e.name === name)?.value;
  }

  async resolve(appId: string): Promise<ResolvedApp> {
    const app = await this.appRepo.findOne({ where: { id: appId } });
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    const cluster = await this.clusterRepo.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster)
      throw new NotFoundException(`Cluster ${app.clusterId} missing`);
    const pgUser = this.envValue(app, 'POSTGRES_USER') ?? 'postgres';
    const pgDb = this.envValue(app, 'POSTGRES_DB') ?? pgUser;
    const pgdata = this.envValue(app, 'PGDATA') ?? DEFAULT_PGDATA;
    const slash = pgdata.lastIndexOf('/');
    return {
      appId,
      clusterId: app.clusterId,
      kubeconfig: this.encryption.decrypt(cluster.kubeconfigEncrypted),
      namespace: app.k8sNamespace,
      labelSelector: `flui-app-id=${app.id}`,
      container: app.slug,
      pgUser,
      pgDb,
      slug: app.slug,
      svcHost: `${app.slug}-svc.${app.k8sNamespace}.svc`,
      pvcRoot: slash > 0 ? pgdata.slice(0, slash) : '/var/lib/postgresql/data',
    };
  }

  async execSql(t: ResolvedApp, sql: string): Promise<string> {
    const b64 = Buffer.from(sql, 'utf-8').toString('base64');
    return this.k8s.execInPod(
      t.kubeconfig,
      t.namespace,
      t.labelSelector,
      t.container,
      [
        'sh',
        '-c',
        `echo ${b64} | base64 -d | gosu postgres psql -U ${t.pgUser} -d ${t.pgDb} -v ON_ERROR_STOP=1 -tA -f -`,
      ],
    );
  }

  execRaw(t: ResolvedApp, shellCommand: string): Promise<string> {
    return this.k8s.execInPod(
      t.kubeconfig,
      t.namespace,
      t.labelSelector,
      t.container,
      ['sh', '-c', shellCommand],
    );
  }

  /** Like execSql but the payload rides stdin — no per-argv size limit. */
  async execSqlStream(t: ResolvedApp, sql: string): Promise<void> {
    await this.k8s.execStream(
      t.kubeconfig,
      t.namespace,
      t.labelSelector,
      [
        'sh',
        '-c',
        `gosu postgres psql -U ${t.pgUser} -d ${t.pgDb} -v ON_ERROR_STOP=1 -tA -f -`,
      ],
      { stdin: Readable.from([sql]) },
      t.container,
    );
  }
}

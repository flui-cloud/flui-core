import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { V1Pod } from '@kubernetes/client-node';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { assertNotPlatformFoundation } from '../constants/platform-foundations';
import {
  declaredEngineOf,
  detectEngineFromImage,
} from '../engine/engine-profile';
import {
  DbPoolerClientCloseResultDto,
  DbPoolerViewDto,
  DbSessionDto,
  DbSessionActionResultDto,
  DbSessionAppRefDto,
  DbSessionsResponseDto,
} from '../dto/db-sessions.dto';
import {
  SessionAction,
  SessionContext,
  assertSessionIdentity,
  parseSnapshot,
  sessionActionSql,
  sessionsListSql,
  toCounts,
  toIsoMillis,
  toSessionDtos,
} from '../engine/postgres-sessions.core';
import { DbConsoleAuditService } from './db-console-audit.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { postgresIdentity } from '../../applications/utils/db-pooler.core';
import {
  DB_POOLER_VIEW_SOURCE,
  DbPoolerViewSource,
  POOLER_OF_LABEL,
  PooledClientRef,
} from './db-pooler-view.source';

const APP_ID_LABEL = 'flui-app-id';

interface SessionsTarget {
  app: ApplicationEntity;
  kubeconfig: string;
}

function shq(v: string): string {
  const escaped = v.replaceAll("'", String.raw`'\''`);
  return `'${escaped}'`;
}

function podAddrs(pod: V1Pod): string[] {
  if (pod.spec?.hostNetwork) return [];
  const ips = new Set<string>();
  if (pod.status?.podIP) ips.add(pod.status.podIP);
  for (const p of pod.status?.podIPs ?? []) if (p.ip) ips.add(p.ip);
  return [...ips];
}

const CLIENT_GONE =
  'That pooled connection has already ended, or its id now names another one.';

/**
 * A database session opened by the pooler belongs to the pooled client that
 * holds it right now: that client's application is who is behind it.
 */
function throughPooler(
  sessions: DbSessionDto[],
  pooler: DbPoolerViewDto,
): DbSessionDto[] {
  const byPid = new Map(
    pooler.clients
      .filter((c) => c.serverPid !== null && c.clientApp)
      .map((c) => [c.serverPid as number, c.clientApp]),
  );
  return sessions.map((s) =>
    s.kind === 'pooler' && byPid.has(s.pid)
      ? { ...s, clientApp: byPid.get(s.pid) ?? null }
      : s,
  );
}

const SESSION_GONE =
  'That session has already ended, or it is not one that can be closed from here.';

/**
 * Who is connected to a managed PostgreSQL and what they are doing, read as the
 * application's superuser over the pod's local socket: that path still gets a
 * reserved slot when every ordinary connection is taken, which is exactly when
 * this view is wanted.
 */
@Injectable()
export class DbSessionsService {
  constructor(
    private readonly applications: ApplicationsRepository,
    private readonly clusters: ClustersService,
    private readonly kubernetes: KubernetesService,
    private readonly audit: DbConsoleAuditService,
    @Inject(DB_POOLER_VIEW_SOURCE)
    private readonly pooler: DbPoolerViewSource,
    private readonly encryption: EncryptionService,
  ) {}

  async list(
    appId: string,
    opts: { includeIdle?: boolean } = {},
  ): Promise<DbSessionsResponseDto> {
    const target = await this.target(appId);
    const [out, ctx] = await Promise.all([
      this.psql(target, sessionsListSql(!!opts.includeIdle)),
      this.context(target),
    ]);
    const snapshot = parseSnapshot(out);
    const pooler = await this.pooler
      .view({
        appId,
        namespace: target.app.k8sNamespace,
        kubeconfig: target.kubeconfig,
        pooler: target.app.pooler,
        appByAddr: ctx.appByAddr,
      })
      .catch(() => null);
    const sessions = toSessionDtos(snapshot.rows ?? [], ctx);
    return {
      engine: 'postgres',
      capturedAt: toIsoMillis(snapshot.captured_at),
      truncated: !!snapshot.truncated,
      maxConnections: Number(snapshot.max_connections),
      total: Number(snapshot.counts.total),
      counts: toCounts(snapshot.counts),
      sessions: pooler ? throughPooler(sessions, pooler) : sessions,
      pooler,
    };
  }

  async act(
    appId: string,
    pid: number,
    backendStart: string,
    action: SessionAction,
    userId?: string,
  ): Promise<DbSessionActionResultDto> {
    try {
      assertSessionIdentity(pid, backendStart);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const target = await this.target(appId);
    let out: string;
    try {
      out = await this.psql(
        target,
        sessionActionSql(action, pid, backendStart),
      );
    } catch (e) {
      this.audit.emitSessionAction({
        dbInstallId: appId,
        userId,
        action,
        pid,
        outcome: 'failed',
      });
      throw e;
    }
    const answer = out.trim().split('\n').pop()?.trim();
    const outcome = answer === 't' ? 'signalled' : 'gone';
    this.audit.emitSessionAction({
      dbInstallId: appId,
      userId,
      action,
      pid,
      outcome,
    });
    if (outcome === 'gone') throw new ConflictException(SESSION_GONE);
    return {
      pid,
      action,
      message:
        action === 'cancel'
          ? `Cancel sent to session ${pid}: its statement stops with an error and the connection stays open.`
          : `Session ${pid} closed: its open transaction, if any, is rolled back.`,
    };
  }

  async closePoolerClient(
    appId: string,
    client: PooledClientRef,
    userId?: string,
  ): Promise<DbPoolerClientCloseResultDto> {
    const target = await this.target(appId);
    if (!target.app.pooler?.enabled) {
      throw new ConflictException('This database has no connection pooler.');
    }
    const event = {
      dbInstallId: appId,
      userId,
      action: 'close_pooled_client' as const,
      pid: client.clientId,
      pod: client.pod,
    };
    let outcome: 'closed' | 'gone';
    try {
      outcome = await this.pooler.closeClient(
        {
          appId,
          namespace: target.app.k8sNamespace,
          kubeconfig: target.kubeconfig,
          pooler: target.app.pooler,
          appByAddr: new Map(),
        },
        client,
      );
    } catch (e) {
      this.audit.emitSessionAction({ ...event, outcome: 'failed' });
      throw new ServiceUnavailableException(
        `Could not reach the pooler: ${(e as Error).message}`,
      );
    }
    this.audit.emitSessionAction({
      ...event,
      outcome: outcome === 'closed' ? 'signalled' : 'gone',
    });
    if (outcome === 'gone') throw new ConflictException(CLIENT_GONE);
    return {
      clientId: client.clientId,
      pod: client.pod,
      message: `Pooled connection ${client.clientId} closed, with the server connection it held; the application has to reconnect.`,
    };
  }

  private async target(appId: string): Promise<SessionsTarget> {
    const app = await this.applications.findById(appId);
    if (!app) throw new NotFoundException(`Database ${appId} not found`);
    assertNotPlatformFoundation(app);
    const engine =
      declaredEngineOf(app.labels) ?? detectEngineFromImage(app.imageRef);
    if (engine !== 'postgres') {
      throw new BadRequestException(
        'Active sessions are available for managed PostgreSQL databases only.',
      );
    }
    return {
      app,
      kubeconfig: await this.clusters.getKubeconfig(app.clusterId),
    };
  }

  private async psql(t: SessionsTarget, sql: string): Promise<string> {
    const { user, database: db } = postgresIdentity(t.app.env, this.encryption);
    const b64 = Buffer.from(sql, 'utf-8').toString('base64');
    try {
      return await this.kubernetes.execInPod(
        t.kubeconfig,
        t.app.k8sNamespace,
        `${APP_ID_LABEL}=${t.app.id}`,
        t.app.slug,
        [
          'sh',
          '-c',
          `echo ${b64} | base64 -d | gosu postgres psql -X -U ${shq(user)} -d ${shq(db)} -v ON_ERROR_STOP=1 -tA -f -`,
        ],
      );
    } catch (e) {
      throw new ServiceUnavailableException(
        `Could not reach the database pod: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Best effort, one pod listing per request: which addresses are this
   * database's pooler, and which belong to an application in its namespace.
   */
  private async context(t: SessionsTarget): Promise<SessionContext> {
    const poolerAddrs = new Set<string>();
    const appByAddr = new Map<string, DbSessionAppRefDto>();
    try {
      const [pods, apps] = await Promise.all([
        this.kubernetes.listPodsByLabel(t.kubeconfig, t.app.k8sNamespace, ''),
        this.applications.findActiveByCluster(t.app.clusterId),
      ]);
      const names = new Map(
        apps
          .filter((a) => a.k8sNamespace === t.app.k8sNamespace)
          .map((a) => [a.id, a.name]),
      );
      for (const pod of pods) {
        const labels = pod.metadata?.labels ?? {};
        if (labels[POOLER_OF_LABEL] === t.app.id) {
          podAddrs(pod).forEach((ip) => poolerAddrs.add(ip));
          continue;
        }
        const id = labels[APP_ID_LABEL];
        const name = id && id !== t.app.id ? names.get(id) : undefined;
        if (id && name) {
          podAddrs(pod).forEach((ip) => appByAddr.set(ip, { id, name }));
        }
      }
    } catch {
      return { poolerAddrs, appByAddr };
    }
    return { poolerAddrs, appByAddr };
  }
}

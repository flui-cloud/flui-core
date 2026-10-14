import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AuditService } from '../../audit/audit.service';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  IDENTITY_CONSOLE_ROW_ID,
  IdentityConsoleGateState,
  IdentityConsoleStateEntity,
} from '../entities/identity-console-state.entity';
import {
  CONSOLE_GATE_HASH_ANNOTATION,
  CONSOLE_GATE_RESOURCES,
  CONSOLE_WINDOW_MINUTES,
  ConsoleGateTarget,
  IDENTITY_PROVIDER_ROUTE_NAME,
  IDENTITY_PROVIDER_SERVICE,
  consoleGateHash,
  ConsoleGateTargetError,
  consoleGateManifests,
  dashboardRedirectTarget,
  gateFailureCause,
  identityProviderHosts,
  isConsoleOpen,
  isWindowExpired,
} from '../utils/identity-console-gate.core';
import { IdentityConsoleStatusDto } from '../dto/identity-console.dto';

export interface IdentityConsoleActor {
  userId?: string | null;
  email?: string | null;
  kind: string;
  keyId?: string | null;
}

const DEFAULT_NAMESPACE = 'flui-system';
const MAX_ENFORCE_PASSES = 3;

/**
 * The identity provider's console, closed unless an administrator opens it for
 * a while. The database says what should be; `reconcile` makes the cluster say
 * the same, on every change and every minute, so an expired window closes
 * itself and a deleted refusal comes back.
 */
@Injectable()
export class IdentityConsoleService {
  private readonly logger = new Logger(IdentityConsoleService.name);

  constructor(
    @InjectRepository(IdentityConsoleStateEntity)
    private readonly states: Repository<IdentityConsoleStateEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpoints: Repository<AppEndpointEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  async status(now = new Date()): Promise<IdentityConsoleStatusDto> {
    return this.toStatus(await this.load(), now);
  }

  async open(
    actor: IdentityConsoleActor,
    minutes: number | undefined,
    reason: string,
    now = new Date(),
  ): Promise<IdentityConsoleStatusDto> {
    if (actor.kind === 'agent') {
      throw new ForbiddenException(
        'Opening the identity provider console is a decision for a person. An agent can read its state only.',
      );
    }
    const span = Math.min(
      Math.max(
        minutes ?? CONSOLE_WINDOW_MINUTES.default,
        CONSOLE_WINDOW_MINUTES.min,
      ),
      CONSOLE_WINDOW_MINUTES.max,
    );
    const openUntil = new Date(now.getTime() + span * 60_000);
    const row = await this.load();
    Object.assign(row, {
      openUntil,
      openedAt: now,
      openedByUserId: actor.userId ?? null,
      openedByEmail: actor.email ?? null,
      reason: reason.trim(),
      closedAt: null,
    });
    await this.states.save(row);
    await this.record(actor, 'identity console opened', {
      until: openUntil.toISOString(),
      minutes: String(span),
      reason: reason.trim(),
    });
    return this.enforceNow(now);
  }

  async close(
    actor: IdentityConsoleActor,
    now = new Date(),
  ): Promise<IdentityConsoleStatusDto> {
    const row = await this.load();
    const wasOpen = isConsoleOpen(row, now);
    Object.assign(row, { openUntil: null, closedAt: now });
    await this.states.save(row);
    await this.record(actor, 'identity console closed', {
      cause: 'manual',
      wasOpen: String(wasOpen),
    });
    return this.enforceNow(now);
  }

  /**
   * Brings the cluster in line with the stored window. Never throws; a failure
   * is kept on the row. Only the applied fields are written, and the window is
   * read again after acting, so an open or close on another replica meanwhile
   * is never undone.
   */
  async reconcile(now = new Date()): Promise<IdentityConsoleStateEntity> {
    await this.closeExpired(now);
    let desired = this.desiredState(await this.load(), now);
    let applied: Partial<IdentityConsoleStateEntity>;
    try {
      const target = await this.resolveTarget();
      let enforced = desired;
      for (let pass = 0; pass < MAX_ENFORCE_PASSES; pass++) {
        if (desired === 'open') await this.removeGate(target);
        else await this.applyGate(target);
        enforced = desired;
        desired = this.desiredState(await this.load(), now);
        if (desired === enforced) break;
      }
      applied = {
        appliedState: enforced,
        appliedHosts: target.hosts,
        appliedRedirect: enforced === 'closed' ? target.redirectTo : null,
        appliedAt: now,
        lastError: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = gateFailureCause(err);
      const previous = (await this.load()).lastError;
      if (previous !== cause) {
        this.logger.warn(
          `Identity console could not be made ${desired}: ${message}`,
        );
      }
      applied = { lastError: cause };
    }
    await this.persistApplied(applied);
    return this.load();
  }

  private async closeExpired(now: Date): Promise<void> {
    const row = await this.load();
    if (!isWindowExpired(row, now)) return;
    const expired = row.openUntil as Date;
    const result = await this.states.update(
      { id: IDENTITY_CONSOLE_ROW_ID, openUntil: expired },
      { openUntil: null, closedAt: now },
    );
    if (result.affected) {
      await this.record({ kind: 'system' }, 'identity console closed', {
        cause: 'expired',
        until: expired.toISOString(),
        openedBy: row.openedByEmail ?? row.openedByUserId ?? 'unknown',
      });
    }
  }

  private desiredState(
    row: IdentityConsoleStateEntity,
    now: Date,
  ): IdentityConsoleGateState {
    return isConsoleOpen(row, now) ? 'open' : 'closed';
  }

  private async persistApplied(
    patch: Partial<IdentityConsoleStateEntity>,
  ): Promise<void> {
    const result = await this.states.update(
      { id: IDENTITY_CONSOLE_ROW_ID },
      patch,
    );
    if (result.affected) return;
    try {
      await this.states.insert({ ...(await this.load()), ...patch });
    } catch {
      await this.states.update({ id: IDENTITY_CONSOLE_ROW_ID }, patch);
    }
  }

  private async enforceNow(now: Date): Promise<IdentityConsoleStatusDto> {
    const row = await this.reconcile(now);
    if (row.lastError) {
      throw new ServiceUnavailableException(
        `Recorded, but the cluster could not be updated yet (${row.lastError}). Flui retries every minute.`,
      );
    }
    return this.toStatus(row, now);
  }

  private async load(): Promise<IdentityConsoleStateEntity> {
    return (
      (await this.states.findOne({ where: { id: IDENTITY_CONSOLE_ROW_ID } })) ??
      this.states.create({
        id: IDENTITY_CONSOLE_ROW_ID,
        openUntil: null,
        openedAt: null,
        openedByUserId: null,
        openedByEmail: null,
        reason: null,
        closedAt: null,
        appliedState: null,
        appliedHosts: null,
        appliedRedirect: null,
        appliedAt: null,
        lastError: null,
      })
    );
  }

  private toStatus(
    row: IdentityConsoleStateEntity,
    now: Date,
  ): IdentityConsoleStatusDto {
    const open = isConsoleOpen(row, now);
    const state: IdentityConsoleGateState = open ? 'open' : 'closed';
    return {
      state,
      openUntil: open ? (row.openUntil?.toISOString() ?? null) : null,
      openedAt: open ? (row.openedAt?.toISOString() ?? null) : null,
      openedBy: open ? (row.openedByEmail ?? row.openedByUserId) : null,
      reason: open ? row.reason : null,
      enforced: row.appliedState === state && !row.lastError,
      hosts: row.appliedHosts ?? [],
      redirectTo: open ? null : (row.appliedRedirect ?? null),
      lastAppliedAt: row.appliedAt?.toISOString() ?? null,
      lastError: row.lastError,
    };
  }

  private async resolveTarget(): Promise<
    ConsoleGateTarget & { kubeconfig: string }
  > {
    const cluster = await this.clusters.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new ConsoleGateTargetError(
        'The control cluster is not registered with a kubeconfig',
      );
    }
    const kubeconfig = this.kubernetes.patchKubeconfigServer(
      this.encryption.decrypt(cluster.kubeconfigEncrypted),
    );
    const app = await this.applications.findOne({
      where: { clusterId: cluster.id, slug: IDENTITY_PROVIDER_ROUTE_NAME },
    });
    const namespace = app?.k8sNamespace || DEFAULT_NAMESPACE;
    const route = await this.kubernetes.getResource(
      kubeconfig,
      'IngressRoute',
      IDENTITY_PROVIDER_ROUTE_NAME,
      namespace,
    );
    const routeBody = route?.body ?? route;
    const endpoints = app
      ? await this.endpoints.find({ where: { applicationId: app.id } })
      : [];
    const hosts = identityProviderHosts({
      routeMatches: (routeBody?.spec?.routes ?? []).map(
        (r: { match?: string }) => r.match,
      ),
      endpointHosts: endpoints.map((e) => e.fqdn),
      issuer: process.env.OIDC_ISSUER ?? process.env.ZITADEL_ISSUER ?? null,
    });
    return {
      kubeconfig,
      namespace,
      hosts,
      service: IDENTITY_PROVIDER_SERVICE,
      redirectTo: dashboardRedirectTarget(
        process.env.FRONTEND_URL || process.env.DASHBOARD_URL,
      ),
    };
  }

  private async applyGate(
    target: ConsoleGateTarget & { kubeconfig: string },
  ): Promise<void> {
    const manifests = consoleGateManifests(target);
    const hash = consoleGateHash(target);
    const current = await Promise.all(
      CONSOLE_GATE_RESOURCES.map((r) =>
        this.kubernetes.getResource(
          target.kubeconfig,
          r.kind,
          r.name,
          target.namespace,
        ),
      ),
    );
    const inPlace = current.every(
      (res) =>
        (res?.body ?? res)?.metadata?.annotations?.[
          CONSOLE_GATE_HASH_ANNOTATION
        ] === hash,
    );
    if (inPlace) return;
    await this.kubernetes.applyManifest(
      target.kubeconfig,
      manifests.map((m) => JSON.stringify(m)).join('\n---\n'),
    );
    this.logger.log(
      `Identity provider console closed on ${target.hosts.join(', ')} (${
        target.redirectTo ? `redirects to ${target.redirectTo}` : 'answers 403'
      })`,
    );
  }

  private async removeGate(
    target: ConsoleGateTarget & { kubeconfig: string },
  ): Promise<void> {
    for (const r of CONSOLE_GATE_RESOURCES) {
      await this.kubernetes.deleteResource(
        target.kubeconfig,
        r.kind,
        r.name,
        target.namespace,
      );
    }
  }

  private record(
    actor: IdentityConsoleActor,
    action: string,
    target: Record<string, string>,
  ): Promise<void> {
    return this.audit.record({
      userId: actor.userId ?? null,
      email: actor.email ?? null,
      actorKind: actor.kind,
      actorKeyId: actor.keyId ?? null,
      action,
      target,
      outcome: 'ok',
      permission:
        actor.kind === 'system' ? null : IAM_PERMISSION.IAM_MANAGE_USERS,
      dataAccess: false,
    });
  }
}

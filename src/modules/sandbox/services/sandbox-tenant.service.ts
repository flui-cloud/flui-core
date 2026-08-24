import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SandboxTenantEntity } from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import { ProjectsService } from '../../projects/projects.service';
import { SandboxBuildTimeline } from './sandbox-build-timeline';
import { SandboxCapacityService } from './sandbox-capacity.service';
import { SandboxHistoryService } from './sandbox-history.service';
import { SandboxReserveService } from './sandbox-reserve.service';
import { SandboxQuotaService } from './sandbox-quota.service';
import { SandboxSeedService } from './sandbox-seed.service';
import { buildSandboxNetworkPolicy } from '../constants/sandbox-network-policy.manifest';
import { buildNoindexMiddleware } from '../constants/sandbox-noindex';
import {
  IDENTITY_DIRECTORY,
  IIdentityDirectory,
} from '../../auth/interfaces/identity-directory.interface';
import { IdentityRole, UserEntity } from '../../auth/entities/user.entity';
import { UserManagementService } from '../../auth/services/user-management.service';
import { ApiKeyEntity } from '../../auth/entities/api-key.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IAM_ROLE } from '../../iam/constants/iam-roles';
import { SHOWCASE_GRANT } from '../../iam/constants/iam-showcase';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { TenancySubdomainService } from '../../dns/services/tenancy-subdomain.service';
import { SandboxSubdomainService } from '../../dns/services/sandbox-subdomain.service';

/**
 * Building a tenancy and taking it apart again.
 *
 * Both directions are written to be safe to run twice. Provisioning can die
 * halfway and leave a row in `failed`, which the reaper treats exactly like an
 * expired one; reaping can die halfway and run again from wherever it got to.
 * The alternative — assuming each step happened — is how a demo quietly keeps
 * paying for namespaces nobody is using.
 */
@Injectable()
export class SandboxTenantService {
  private readonly logger = new Logger(SandboxTenantService.name);

  constructor(
    private readonly reserve: SandboxReserveService,
    private readonly capacity: SandboxCapacityService,
    private readonly quota: SandboxQuotaService,
    private readonly seed: SandboxSeedService,
    private readonly history: SandboxHistoryService,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @Inject(IDENTITY_DIRECTORY)
    private readonly directory: IIdentityDirectory,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @InjectRepository(ApiKeyEntity)
    private readonly apiKeys: Repository<ApiKeyEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly projects: ProjectsService,
    private readonly userManagement: UserManagementService,
    private readonly appEndpoints: AppEndpointService,
    private readonly endpointReconciliation: AppEndpointReconciliationService,
    private readonly tenancySubdomains: TenancySubdomainService,
    private readonly sandboxSubdomains: SandboxSubdomainService,
  ) {}

  async provision(clusterId: string): Promise<SandboxTenantEntity> {
    const timeline = new SandboxBuildTimeline();
    const tenant = await this.reserve.createPending(clusterId);
    try {
      const created = await this.directory.createUser({
        email: tenant.email,
        firstName: 'Sandbox',
        lastName: 'Guest',
        sendInvite: false,
        role: IdentityRole.USER,
      });

      // The local row normally appears on first login. Creating it now is what
      // lets the owner grant exist before the guest ever signs in — the grant
      // selects on this id.
      const user = await this.users.save(
        this.users.create({
          email: tenant.email,
          oidcSub: created.id,
          role: IdentityRole.USER,
          isAdmin: false,
          firstName: 'Sandbox',
          lastName: 'Guest',
          passwordHash: null,
        }),
      );

      await this.reserve.recordIdentities(tenant.id, {
        userId: user.id,
        idpUserId: created.id,
      });
      timeline.mark('identity');

      // Two grants, deliberately separate. The first is the tenancy: everything
      // this guest makes, and nothing else. The second is the showcase: read-only
      // over what the platform's own operators run, so the guest has something
      // real to look at that they could never afford to start themselves.
      await this.bindings.save([
        this.bindings.create({
          principalType: 'user',
          principalRef: tenant.email,
          role: IAM_ROLE.SANDBOX,
          scopeType: 'selector',
          scopeRef: null,
          selector: { owner: user.id },
        }),
        this.bindings.create({
          principalType: 'user',
          principalRef: tenant.email,
          role: SHOWCASE_GRANT.role,
          scopeType: 'selector',
          scopeRef: null,
          selector: SHOWCASE_GRANT.selector,
        }),
      ]);
      timeline.mark('grants');

      const kubeconfig = await this.kubeconfigFor(clusterId);
      await this.k8s.ensureNamespaceExists(kubeconfig, tenant.namespace, {
        'flui.cloud/sandbox': 'true',
        'flui.cloud/sandbox-tenant': tenant.id,
      });
      await this.quota.apply(kubeconfig, tenant.namespace);
      // Both fences go up before anything runs in here, so there is no window in
      // which a seeded workload is reachable from another tenancy.
      await this.k8s.applyManifest(
        kubeconfig,
        buildSandboxNetworkPolicy(tenant.namespace),
      );
      await this.k8s.applyManifest(
        kubeconfig,
        buildNoindexMiddleware(tenant.namespace),
      );
      timeline.mark('namespace');

      // Before the seed, because the seed is what creates the endpoints that
      // will carry the name: an application deployed before the certificate is
      // valid keeps the shared hostname for as long as it lives, since a
      // hostname is written once. This is also the only place the wait is free
      // — a background refill, not a visitor watching a spinner.
      //
      // Never fatal: a tenancy without its own certificate is a tenancy on the
      // shared name, which is where every tenancy is today.
      const cluster = await this.clusters.findOne({ where: { id: clusterId } });
      if (cluster) {
        // The shared subdomain first: it is the decided shape, and it is the
        // one whose cost does not grow with the number of guests — the first
        // tenancy pays for the certificate and every one after it reads a row.
        await this.sandboxSubdomains.ensure(cluster, tenant.namespace);
        await this.tenancySubdomains.ensureCertificate(
          cluster,
          tenant.namespace,
        );
        timeline.mark('tenancy certificate');
      }

      // Readiness waits for the seed. A tenancy is only warm once there is
      // something running in it — that is the whole reason the reserve exists.
      const installId = await this.seed.seed({ ...tenant, userId: user.id });
      timeline.mark('seed queued');
      const seeded = await this.seed.waitUntilSeeded(installId);
      if (!seeded) {
        throw new Error(
          `seed install ${installId} did not reach Running — tenancy not offered`,
        );
      }
      timeline.mark('seed running');

      // The seed leaves a database with about a minute of rows in it. This is
      // where the tenancy stops looking newly born: a copy of what the
      // reference instance has actually accumulated. Done here, on a tenancy
      // nobody holds yet, rather than during the entrance.
      await this.history.copyInto({ ...tenant, userId: user.id });
      timeline.mark('history');

      await this.seed.groupUnderProject(tenant);
      timeline.mark('project');

      await this.reserve.markReady(tenant.id, {
        userId: user.id,
        idpUserId: created.id,
      });
      // Broken down on purpose: this is the number the buffer is sized against,
      // and a single total would hide that one step is nearly all of it.
      this.logger.log(
        `Sandbox tenancy ${tenant.namespace} is ready — ${timeline}`,
      );
      // Back into the rule that decides how many to keep warm, so a seed that
      // gets slower widens the buffer by itself instead of waiting for somebody
      // to notice and edit a number.
      this.capacity.recordBuild(timeline.totalMs / 1000);
      return tenant;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.reserve.markFailed(tenant.id, message);
      // The timeline goes out on the failure too: where a build dies is the
      // thing that tells a failed provider apart from a slow one.
      this.logger.error(
        `Provisioning ${tenant.namespace} failed after ${timeline}: ${message}. The reaper will clean it up.`,
      );
      throw error;
    }
  }

  /**
   * Take a tenancy apart. Order matters: the namespace goes first because it is
   * the only step that costs real resources, so a failure later leaves nothing
   * running. Every step tolerates "already gone".
   */
  async reap(tenant: SandboxTenantEntity): Promise<void> {
    const failures: string[] = [];
    const notes: string[] = [];

    const cluster = await this.clusters.findOne({
      where: { id: tenant.clusterId },
    });
    if (!cluster) {
      // The cluster this tenancy lived on is no longer registered. Its namespace
      // went with it, and no credential exists on this side that could delete
      // one now — so there is nothing here to retry. Recorded rather than
      // silent, because "we did not check" and "there was nothing" are
      // different sentences and only one of them is true.
      notes.push(
        `namespace: cluster ${tenant.clusterId} is no longer registered, nothing left to delete`,
      );
    } else {
      try {
        const kubeconfig = await this.kubeconfigFor(tenant.clusterId);
        await this.k8s.deleteNamespace(kubeconfig, tenant.namespace);
      } catch (error) {
        failures.push(`namespace: ${this.msg(error)}`);
      }
    }

    try {
      await this.deleteEndpoints(tenant);
    } catch (error) {
      failures.push(`endpoints: ${this.msg(error)}`);
    }

    await this.releaseTenancyCertificate(cluster, tenant, notes, failures);

    try {
      // Read the grouping before the applications go: deleting them sets their
      // projectId to NULL via the foreign key, and a project nothing points at
      // is a "Demo" row that outlives every tenancy that ever had one.
      const grouped = await this.applications.find({
        where: { clusterId: tenant.clusterId, k8sNamespace: tenant.namespace },
        select: { id: true, projectId: true },
      });
      const projectIds = new Set(
        grouped
          .map((app) => app.projectId)
          .filter((id): id is string => typeof id === 'string'),
      );

      await this.applications.delete({
        clusterId: tenant.clusterId,
        k8sNamespace: tenant.namespace,
      });

      for (const projectId of projectIds) {
        await this.projects.remove(projectId);
      }
    } catch (error) {
      failures.push(`applications: ${this.msg(error)}`);
    }

    // The same cleanup the administrative delete performs, not a second one
    // written here: a binding names a person by email *or* by local id, and the
    // query this used to run took only the first kind away.
    try {
      await this.userManagement.detachRoleBindings({
        id: tenant.userId,
        email: tenant.email,
      });
    } catch (error) {
      failures.push(`binding: ${this.msg(error)}`);
    }

    // Before the local user row, and explicitly: `api_keys` has no foreign key
    // to `users`, so deleting the person leaves every credential they minted
    // behind as a row pointing at nobody. The tenancy's own session credential
    // is one of those, and so is every key the guest handed to an agent.
    try {
      if (tenant.userId) {
        const removed = await this.apiKeys.delete({ userId: tenant.userId });
        if (removed.affected) {
          notes.push(`api keys: removed ${removed.affected}`);
        }
      }
    } catch (error) {
      failures.push(`api keys: ${this.msg(error)}`);
    }

    let identityGone = true;
    try {
      const idpUserId =
        tenant.idpUserId ?? (await this.findIdpUserByEmail(tenant.email));
      if (idpUserId) {
        await this.directory.deleteUser(idpUserId);
      }
    } catch (error) {
      // "Not found" is the outcome we wanted, reported as an error: the account
      // is not there. Treating it as a failure would keep the local row — and
      // the retry — forever, for a tenancy that is already fully gone.
      if (error instanceof NotFoundException) {
        this.logger.debug(
          `Identity for ${tenant.namespace} was already gone: ${this.msg(error)}`,
        );
      } else {
        identityGone = false;
        failures.push(`idp user: ${this.msg(error)}`);
      }
    }

    // The local row is the last thing to go, and only once the account it
    // mirrors is actually gone. Deleting it first leaves a person in the
    // identity provider with nothing on this side that remembers to remove them
    // — a failure that leaves no trace to search for. Keeping the row costs a
    // dead record until the next sweep retries it; losing it costs an account
    // nobody knows about.
    if (identityGone) {
      try {
        await this.users.delete({ email: tenant.email });
      } catch (error) {
        failures.push(`local user: ${this.msg(error)}`);
      }
    } else {
      failures.push('local user: kept, the identity it mirrors is still there');
    }

    if (failures.length > 0) {
      // Deliberately not thrown: a partial reap must still be recorded, or the
      // next run starts from the beginning and the namespace outlives everything.
      await this.reserve.markFailed(tenant.id, failures.join('; '));
      this.logger.warn(
        `Reaping ${tenant.namespace} was incomplete: ${failures.join('; ')}`,
      );
      return;
    }

    await this.reserve.markExpired(tenant.id);
    this.logger.log(
      `Sandbox tenancy ${tenant.namespace} reaped` +
        (notes.length > 0 ? ` (${notes.join('; ')})` : ''),
    );
  }

  /**
   * Reap one tenancy now, on somebody's say-so rather than on a deadline.
   *
   * Deliberately the same path the sweep takes: an area that is deleted some
   * other way leaves the identity-provider account behind, which is a defect
   * this code has already had once.
   */
  async expireNow(tenant: SandboxTenantEntity): Promise<SandboxTenantEntity> {
    await this.reap(tenant);
    return this.reserve.getById(tenant.id);
  }

  /**
   * The tenancy's own wildcard certificate. Its master Secret lives in
   * `flui-system`, so deleting the tenancy's namespace does not take it:
   * without this, every reaped tenancy leaves behind a certificate that keeps
   * renewing, forever, for a name nothing serves.
   */
  private async releaseTenancyCertificate(
    cluster: ClusterEntity | null,
    tenant: SandboxTenantEntity,
    notes: string[],
    failures: string[],
  ): Promise<void> {
    if (!cluster) return;
    try {
      const removed = await this.tenancySubdomains.releaseCertificates(
        cluster,
        tenant.namespace,
      );
      if (removed) notes.push(`tenancy certificates: removed ${removed}`);
    } catch (error) {
      failures.push(`tenancy certificate: ${this.msg(error)}`);
    }
  }

  private async deleteEndpoints(tenant: SandboxTenantEntity): Promise<void> {
    const endpoints = await this.appEndpoints.listByNamespace(
      tenant.clusterId,
      tenant.namespace,
    );
    const failures: string[] = [];

    for (const endpoint of endpoints) {
      try {
        await this.endpointReconciliation.deleteEndpointResources(endpoint.id);
        await this.appEndpoints.deleteEndpoint(endpoint.id);
      } catch (error) {
        failures.push(`${endpoint.fqdn}: ${this.msg(error)}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
  }

  /**
   * Last resort for rows written before the identity was recorded, and for any
   * crash between creating the account and writing it down. Matching is exact:
   * `emailContains` is a substring search, and one guest address must never
   * select another's account.
   */
  private async findIdpUserByEmail(email: string): Promise<string | null> {
    const matches = await this.directory.listUsers({ emailContains: email });
    return matches.find((u) => u.email === email)?.id ?? null;
  }

  private msg(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return JSON.stringify(error) ?? 'unknown error';
  }

  private async kubeconfigFor(clusterId: string): Promise<string> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(`Cluster ${clusterId} has no kubeconfig`);
    }
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}

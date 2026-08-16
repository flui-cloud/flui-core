import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SandboxTenantEntity } from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
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
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IAM_ROLE } from '../../iam/constants/iam-roles';
import { SHOWCASE_GRANT } from '../../iam/constants/iam-showcase';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

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
    private readonly quota: SandboxQuotaService,
    private readonly seed: SandboxSeedService,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
    @Inject(IDENTITY_DIRECTORY)
    private readonly directory: IIdentityDirectory,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  async provision(clusterId: string): Promise<SandboxTenantEntity> {
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

      // Readiness waits for the seed. A tenancy is only warm once there is
      // something running in it — that is the whole reason the reserve exists.
      const installId = await this.seed.seed({ ...tenant, userId: user.id });
      const seeded = await this.seed.waitUntilSeeded(installId);
      if (!seeded) {
        throw new Error(
          `seed install ${installId} did not reach Running — tenancy not offered`,
        );
      }

      await this.reserve.markReady(tenant.id, {
        userId: user.id,
        idpUserId: created.id,
      });
      this.logger.log(`Sandbox tenancy ${tenant.namespace} is ready`);
      return tenant;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.reserve.markFailed(tenant.id, message);
      this.logger.error(
        `Provisioning ${tenant.namespace} failed: ${message}. The reaper will clean it up.`,
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

    try {
      const kubeconfig = await this.kubeconfigFor(tenant.clusterId);
      await this.k8s.deleteNamespace(kubeconfig, tenant.namespace);
    } catch (error) {
      failures.push(`namespace: ${this.msg(error)}`);
    }

    try {
      await this.applications.delete({
        clusterId: tenant.clusterId,
        k8sNamespace: tenant.namespace,
      });
    } catch (error) {
      failures.push(`applications: ${this.msg(error)}`);
    }

    try {
      await this.bindings.delete({ principalRef: tenant.email });
    } catch (error) {
      failures.push(`binding: ${this.msg(error)}`);
    }

    try {
      const idpUserId =
        tenant.idpUserId ?? (await this.findIdpUserByEmail(tenant.email));
      if (idpUserId) {
        await this.directory.deleteUser(idpUserId);
      }
    } catch (error) {
      failures.push(`idp user: ${this.msg(error)}`);
    }

    try {
      await this.users.delete({ email: tenant.email });
    } catch (error) {
      failures.push(`local user: ${this.msg(error)}`);
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
    this.logger.log(`Sandbox tenancy ${tenant.namespace} reaped`);
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

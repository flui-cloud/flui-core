import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ProjectsService } from '../../projects/projects.service';
import { CatalogInstallRepository } from '../../catalog/repositories/catalog-install.repository';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { SandboxTenantEntity } from '../entities/sandbox-tenant.entity';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';

/**
 * Puts something alive in a tenancy before anyone arrives in it.
 *
 * It installs the catalogue's own demo application rather than assembling one
 * here: four composed components (Postgres, Redis, NATS and the app) that are
 * genuinely in each other's data path, so the logs move and the graphs climb
 * without a load generator dressed up as users. Reusing the catalogue entry also
 * means there is one definition of that app, not a second one here to drift.
 *
 * The install runs as the guest, which is what keeps the seed inside the fence:
 * the catalogue processor derives the namespace from the guest's email and the
 * applications it creates carry the guest's id, and an application with no owner
 * is readable by every authenticated caller.
 */
@Injectable()
export class SandboxSeedService {
  private readonly logger = new Logger(SandboxSeedService.name);

  constructor(
    private readonly installer: CatalogInstallerService,
    private readonly installs: CatalogInstallRepository,
    private readonly projects: ProjectsService,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  async seed(tenant: SandboxTenantEntity): Promise<string> {
    const { install } = await this.installer.install(
      this.config.seedCatalogSlug,
      {
        clusterId: tenant.clusterId,
        // Says when it started, because that is the part a visitor would
        // otherwise get wrong. It has been running for minutes, not for days —
        // the records inside it are older than the process that is serving them.
        displayName: 'Live activity (started for you)',
        // Off by default. A guest's workload on the control-plane node shares a
        // machine with the API, the database and every other tenancy, which is
        // the blast radius the whole fence exists to avoid — a real demo instance
        // has worker nodes. The switch exists for a single-node test cluster.
        allowMasterPlacement: this.config.allowMasterPlacement,
        // The catalogue entry is written for a real deployment: its Postgres
        // asks for a 2-core, 2Gi ceiling, which a tenancy must never hand to a
        // single container. Capping the seed keeps the fence tight instead of
        // widening it to fit.
        resourceOverrides: { cpu: { limit: '1' }, memory: { limit: '1Gi' } },
      } as never,
      tenant.userId ?? undefined,
      tenant.email,
    );

    this.logger.log(
      `Seeding ${this.config.seedCatalogSlug} into ${tenant.namespace} (install ${install.id})`,
    );
    return install.id;
  }

  /**
   * Wait for the seed to actually be running.
   *
   * The install is queued, so provisioning would otherwise call a tenancy warm
   * while its four components were still being scheduled — and a tenancy handed
   * out with an empty namespace breaks the one promise the first screen makes.
   * Better a shallower reserve, and an honest "come back in a few minutes", than
   * a guest who lands on nothing.
   */
  async waitUntilSeeded(installId: string): Promise<boolean> {
    const deadline = Date.now() + this.config.seedTimeoutMs;

    while (Date.now() < deadline) {
      const install = await this.installs.findById(installId);
      if (install?.status === CatalogInstallStatus.RUNNING) return true;
      if (install?.status === CatalogInstallStatus.FAILED) {
        this.logger.warn(
          `Seed install ${installId} failed: ${install.errorMessage ?? 'no reason recorded'}`,
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    this.logger.warn(`Seed install ${installId} did not finish in time`);
    return false;
  }

  /**
   * Put the seeded workload inside a project of the tenancy's own.
   *
   * Not decoration: Projects is a section of the product, and a guest who opens
   * it to "No projects yet" is being shown an empty feature rather than a
   * grouped one — the same defect as the empty application list, one screen
   * further in. One project per tenancy also means the projection over
   * `GET /projects` has something true to return.
   *
   * Failing here must not cost the tenancy: a guest with a running application
   * and no project is a smaller loss than no tenancy at all.
   */
  async groupUnderProject(tenant: SandboxTenantEntity): Promise<void> {
    try {
      const apps = await this.applications.find({
        where: { clusterId: tenant.clusterId, k8sNamespace: tenant.namespace },
        select: { id: true },
      });
      if (apps.length === 0) return;

      const project = await this.projects.create({
        name: 'Demo',
        description: 'Started with this area, and not from an empty database.',
        color: '#3b82f6',
      });
      for (const app of apps) {
        await this.projects.assignApp(project.id, app.id);
      }
      this.logger.log(
        `Grouped ${apps.length} seeded applications of ${tenant.namespace} under project ${project.slug}`,
      );
    } catch (error) {
      this.logger.warn(
        `Could not group the seed of ${tenant.namespace} under a project: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

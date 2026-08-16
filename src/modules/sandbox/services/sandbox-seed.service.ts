import { Inject, Injectable, Logger } from '@nestjs/common';
import { CatalogInstallerService } from '../../catalog/services/catalog-installer.service';
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
    @Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig,
  ) {}

  async seed(tenant: SandboxTenantEntity): Promise<string> {
    const { install } = await this.installer.install(
      this.config.seedCatalogSlug,
      {
        clusterId: tenant.clusterId,
        displayName: 'Live activity (seeded)',
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
}

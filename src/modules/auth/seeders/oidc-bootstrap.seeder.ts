import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  OIDC_BOOTSTRAP_QUEUE,
  OIDC_BOOTSTRAP_JOB,
} from '../processors/oidc-bootstrap.processor';
import { OidcBootstrapService } from '../services/oidc-bootstrap.service';

const JOB_ID = 'oidc-bootstrap-singleton';

/**
 * Fallback for setup-zitadel-oidc.sh (run by k3s-master-init.sh): enqueues a
 * one-shot OIDC provider bootstrap if AUTH_MODE=oidc and OIDC_AUDIENCE is
 * still empty when flui-api boots — i.e. the bootstrap script failed or was
 * skipped. When the script succeeded, flui-secrets already carries
 * OIDC_AUDIENCE and this seeder is a no-op.
 */
@Injectable()
export class OidcBootstrapSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(OidcBootstrapSeeder.name);

  constructor(
    @InjectQueue(OIDC_BOOTSTRAP_QUEUE)
    private readonly queue: Queue,
    private readonly oidcBootstrapService: OidcBootstrapService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const authMode = (process.env.AUTH_MODE ?? '').toLowerCase();
    if (authMode !== 'oidc') return;

    // OIDC_AUDIENCE is the client ID of the OIDC app and is empty until the
    // provider app has been created — it is the authoritative marker of
    // "bootstrap done". OIDC_ISSUER is set up-front by the bootstrap manifests,
    // so it cannot be used to detect a fresh cluster.
    const audience = (process.env.OIDC_AUDIENCE ?? '').trim();
    if (audience) {
      this.logger.debug(`OIDC_AUDIENCE already set — skipping OIDC bootstrap`);
      await this.ensureCliApp();
      await this.reconcileProjectRoles();
      return;
    }

    try {
      const existing = await this.queue.getJob(JOB_ID);
      if (existing) {
        const state = await existing.getState();
        if (state === 'active' || state === 'waiting' || state === 'delayed') {
          this.logger.log(
            `OIDC bootstrap job already in queue (state=${state})`,
          );
          return;
        }
        await existing.remove();
      }

      await this.queue.add(
        OIDC_BOOTSTRAP_JOB,
        {},
        {
          jobId: JOB_ID,
          attempts: 10,
          backoff: { type: 'exponential', delay: 15_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      this.logger.log(
        'OIDC bootstrap job enqueued (OIDC mode, issuer not yet configured)',
      );
    } catch (err) {
      this.logger.error(`Failed to enqueue OIDC bootstrap job: ${err.message}`);
    }
  }

  /**
   * The roles Flui knows about, made to exist in the provider on an
   * installation that was bootstrapped before they did.
   *
   * `bootstrap()` runs once and never again, so without this a rung or an agent
   * scope added to the model would be readable by this build and ungrantable on
   * every instance already in the field. Additive and idempotent — it creates
   * what is missing and deletes nothing — and warn-only, because a provider
   * that is down at boot must not stop the API from starting: Flui's own
   * bindings are unaffected, and the next boot tries again.
   */
  private async reconcileProjectRoles(): Promise<void> {
    try {
      await this.oidcBootstrapService.reconcileProjectRoles();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Could not reconcile provider project roles: ${message}`,
      );
    }
  }

  private async ensureCliApp(): Promise<void> {
    const cliClientId = (process.env.OIDC_CLI_CLIENT_ID ?? '').trim();
    if (cliClientId) return;

    this.logger.log(
      'OIDC_CLI_CLIENT_ID missing — provisioning Flui CLI OIDC app...',
    );
    try {
      const result = await this.oidcBootstrapService.provisionCliApp();
      process.env.OIDC_CLI_CLIENT_ID = result.clientId;
      this.logger.log(
        `Flui CLI OIDC app provisioned (clientId=${result.clientId})`,
      );
    } catch (err) {
      this.logger.warn(`Could not provision CLI OIDC app: ${err.message}`);
    }
  }
}

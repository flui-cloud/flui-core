import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { detectSecretsEngine } from '../engine/secrets-engine';
import { SecretsQueryService } from '../services/secrets-query.service';

/**
 * OpenBao comes up sealed after every pod restart. The console bootstrap only
 * re-unseals on user access, so a consumer app that reads secrets directly would
 * stay broken until someone opens the console (observed: an install stayed sealed
 * for ~a day). This reconcile proactively re-unseals every initialised OpenBao
 * install from its stored key, so a restart self-heals within one tick. It never
 * initialises (see SecretsBootstrapService.reconcileUnseal).
 */
@Injectable()
export class OpenbaoUnsealScheduler {
  private readonly logger = new Logger(OpenbaoUnsealScheduler.name);
  private running = false;

  constructor(
    private readonly applications: ApplicationsRepository,
    private readonly secrets: SecretsQueryService,
  ) {}

  @Cron(process.env.OPENBAO_UNSEAL_CRON || CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const apps = (await this.applications.findAllActive()).filter(
        (a) => detectSecretsEngine(a.imageRef) === 'openbao',
      );
      for (const app of apps) {
        try {
          const result = await this.secrets.ensureUnsealed(app.id);
          if (result.unsealed) {
            this.logger.log(`Auto-unsealed OpenBao ${app.slug} after restart`);
          } else if (result.reason === 'no-key') {
            this.logger.warn(
              `OpenBao ${app.slug} is sealed but has no stored unseal key — ` +
                'open its secrets console once to initialise it',
            );
          }
        } catch (err) {
          this.logger.warn(
            `OpenBao unseal reconcile failed for ${app.slug}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}

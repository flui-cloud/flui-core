import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccessModule } from '../access/access.module';
import { ScalewayProviderModule } from '../providers/implementations/scaleway/scaleway-provider.module';
import { MailController } from './controllers/mail.controller';
import { MailConnectionsController } from './controllers/mail-connections.controller';
import { MailCredentialsService } from './services/mail-credentials.service';
import { MailReadinessService } from './services/mail-readiness.service';
import { MailSendService } from './services/mail-send.service';
import { MailSuppressionService } from './services/mail-suppression.service';
import { MailSuppressionEntity } from './entities/mail-suppression.entity';
import { MailEventEntity } from './entities/mail-event.entity';
import { MailConnectionEntity } from './entities/mail-connection.entity';
import { MailConnectionService } from './services/mail-connection.service';
import { MailProviderResolver } from './services/mail-provider.resolver';
import { MailOnboardingService } from './services/mail-onboarding.service';
import { MailSetupService } from './services/mail-setup.service';
import { MailWebhookRegistrarService } from './services/mail-webhook-registrar.service';
import { MailWebhookService } from './services/mail-webhook.service';
import { MailWebhookController } from './controllers/mail-webhook.controller';
import { MailEventStoreService } from './services/mail-event-store.service';
import { MailPollService } from './services/mail-poll.service';
import { MailPollScheduler } from './schedulers/mail-poll.scheduler';
import { MailOverviewService } from './services/mail-overview.service';
import { MailTestService } from './services/mail-test.service';
import { MailDnsWriterService } from './services/mail-dns-writer.service';
import { InviteMailService } from './services/invite-mail.service';
import { DnsZoneEntity } from '../dns/entities/dns-zone.entity';
import { ProvidersModule } from '../providers/providers.module';

/**
 * The email capability.
 *
 * Provider knowledge — payloads, record names, what each refusal means — lives
 * in `@flui-cloud/mail`, which is consumed here as a library. This module is
 * the host side of its seams: where the credential comes from, who writes DNS,
 * where suppressions are stored. Keeping the split means a provider is added by
 * writing a driver, not by touching the platform.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MailSuppressionEntity,
      MailEventEntity,
      MailConnectionEntity,
      DnsZoneEntity,
    ]),
    AccessModule,
    ScalewayProviderModule,
    ProvidersModule,
  ],
  controllers: [
    MailController,
    MailConnectionsController,
    MailWebhookController,
  ],
  providers: [
    MailCredentialsService,
    MailConnectionService,
    MailProviderResolver,
    MailOnboardingService,
    MailSetupService,
    MailWebhookRegistrarService,
    MailWebhookService,
    MailReadinessService,
    MailSendService,
    MailSuppressionService,
    MailDnsWriterService,
    MailEventStoreService,
    MailPollService,
    MailOverviewService,
    MailTestService,
    MailPollScheduler,
    InviteMailService,
  ],
  exports: [
    MailCredentialsService,
    MailConnectionService,
    MailProviderResolver,
    MailOnboardingService,
    MailSetupService,
    MailWebhookRegistrarService,
    MailReadinessService,
    MailSendService,
    MailSuppressionService,
    MailDnsWriterService,
    MailEventStoreService,
    MailPollService,
    MailOverviewService,
    MailTestService,
    InviteMailService,
  ],
})
export class MailModule {}

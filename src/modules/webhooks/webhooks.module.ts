import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ObservabilityModule } from '../observability/observability.module';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ApplicationsModule } from '../applications/applications.module';
import { ImageRegistryModule } from '../image-registry/image-registry.module';
import { RepositoriesModule } from '../repositories/repositories.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { GitHubAppWebhookService } from './services/github-app-webhook.service';
import { AlertsWebhookService } from './services/alerts-webhook.service';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([ApplicationEntity]),
    ApplicationsModule,
    ImageRegistryModule,
    RepositoriesModule,
    ObservabilityModule,
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, GitHubAppWebhookService, AlertsWebhookService],
})
export class WebhooksModule {}

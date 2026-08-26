import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { SharedModule } from '../shared/shared.module';
import { GitModule } from '../git/git.module';
import { FrameworksModule } from '../frameworks/frameworks.module';
import { RepositoryEntity } from './entities/repository.entity';
import { RepositoryCredentialEntity } from './entities/repository-credential.entity';
import { GitHubIntegrationConfigEntity } from './entities/github-integration-config.entity';
import { GitHubAppInstallationEntity } from './entities/github-app-installation.entity';
import { GithubUserTokenEntity } from './entities/github-user-token.entity';
import { GithubAppManifestStateEntity } from './entities/github-app-manifest-state.entity';
import { RepositoriesRepository } from './repositories/repositories.repository';
import { RepositoryCredentialsRepository } from './repositories/repository-credentials.repository';
import { RepositoriesService } from './services/repositories.service';
import { WebhookService } from './services/webhook.service';
import { GitHubOAuthService } from './services/github-oauth.service';
import { GitHubIntegrationConfigService } from './services/github-integration-config.service';
import { GitHubAppService } from './services/github-app.service';
import { GitHubInstallationAccessService } from './services/github-installation-access.service';
import { GitHubTokenResolverService } from './services/github-token-resolver.service';
import { GithubAppInstallStateService } from './services/github-app-install-state.service';
import { GithubAppManifestStateService } from './services/github-app-manifest-state.service';
import { GithubAppUserAuthService } from './services/github-app-user-auth.service';
import { EnvExtractorService } from './services/env-extractor.service';
import { DockerfileAnalyzerService } from './services/dockerfile-analyzer.service';
import { WorkflowGeneratorService } from './services/workflow-generator.service';
import { GitHubWorkflowService } from './services/github-workflow.service';
import { GhcrPackagesService } from './services/ghcr-packages.service';
import { GhcrPatAuditService } from './services/ghcr-pat-audit.service';
import { RepositoriesController } from './controllers/repositories.controller';
import { GitHubOAuthController } from './controllers/github-oauth.controller';
import { GitHubSetupController } from './controllers/github-setup.controller';
import { GithubAppOAuthController } from './controllers/github-app-oauth.controller';
import { UserEventsGateway } from '../auth/gateway/user-events.gateway';
import { WsAuthModule } from '../auth/ws-auth.module';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    TypeOrmModule.forFeature([
      RepositoryEntity,
      RepositoryCredentialEntity,
      GitHubIntegrationConfigEntity,
      GitHubAppInstallationEntity,
      GithubUserTokenEntity,
      GithubAppManifestStateEntity,
    ]),
    SharedModule,
    GitModule,
    FrameworksModule,
    WsAuthModule,
  ],
  controllers: [
    RepositoriesController,
    GitHubOAuthController,
    GitHubSetupController,
    GithubAppOAuthController,
  ],
  providers: [
    RepositoriesRepository,
    RepositoryCredentialsRepository,
    RepositoriesService,
    WebhookService,
    GitHubOAuthService,
    GitHubIntegrationConfigService,
    GitHubAppService,
    GitHubInstallationAccessService,
    GitHubTokenResolverService,
    GithubAppInstallStateService,
    GithubAppManifestStateService,
    GithubAppUserAuthService,
    UserEventsGateway,
    EnvExtractorService,
    DockerfileAnalyzerService,
    WorkflowGeneratorService,
    GitHubWorkflowService,
    GhcrPackagesService,
    GhcrPatAuditService,
  ],
  exports: [
    RepositoriesService,
    WebhookService,
    RepositoriesRepository,
    GitHubOAuthService,
    GitHubIntegrationConfigService,
    GitHubAppService,
    GitHubTokenResolverService,
    GithubAppUserAuthService,
    GithubAppManifestStateService,
    UserEventsGateway,
    EnvExtractorService,
    DockerfileAnalyzerService,
    WorkflowGeneratorService,
    GitHubWorkflowService,
    GhcrPackagesService,
  ],
})
export class RepositoriesModule {}

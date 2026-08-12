// Single source of truth for the primary connection's entity set.
// Imported by BOTH app.module (TypeOrmModule.forRoot) and config/data-source
// (TypeORM CLI). Keeping one list prevents the drift that silently broke
// migration:generate — the CLI data-source used to lag app.module and emit
// bogus diffs. Add new entities here only.

import { SSHKeyEntity } from '../modules/access/entities/ssh-key.entity';
import { ProviderCredentialsEntity } from '../modules/access/entities/credentials.entity';
import { ApiTokenEntity } from '../modules/access/entities/api-token.entity';
import { ProviderConfigurationEntity } from '../modules/management/entities/provider-configuration.entity';
import { InfrastructureOperationEntity } from '../modules/infrastructure/servers/entities/infrastructure-operations.entity';
import { ServerEntity } from '../modules/infrastructure/servers/entities/server.entity';
import { ClusterEntity } from '../modules/infrastructure/clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../modules/infrastructure/clusters/entities/cluster-node.entity';
import { NodeBillableIntervalEntity } from '../modules/infrastructure/clusters/entities/node-billable-interval.entity';
import { VolumeBillableIntervalEntity } from '../modules/infrastructure/clusters/entities/volume-billable-interval.entity';
import { CAKeypairEntity } from '../modules/access/entities/ca-keypair.entity';
import { RepositoryEntity } from '../modules/repositories/entities/repository.entity';
import { RepositoryCredentialEntity } from '../modules/repositories/entities/repository-credential.entity';
import { GitHubIntegrationConfigEntity } from '../modules/repositories/entities/github-integration-config.entity';
import { GitHubAppInstallationEntity } from '../modules/repositories/entities/github-app-installation.entity';
import { GithubUserTokenEntity } from '../modules/repositories/entities/github-user-token.entity';
import { GithubAppManifestStateEntity } from '../modules/repositories/entities/github-app-manifest-state.entity';
import { ClusterFirewallEntity } from '../modules/infrastructure/firewalls/entities/cluster-firewall.entity';
import { FirewallEntity } from '../modules/infrastructure/firewalls/entities/firewall.entity';
import { VNetEntity } from '../modules/infrastructure/vnets/entities/vnet.entity';
import { VNetSubnetEntity } from '../modules/infrastructure/vnets/entities/vnet-subnet.entity';
import { VNetRouteEntity } from '../modules/infrastructure/vnets/entities/vnet-route.entity';
import { DnsZoneEntity } from '../modules/dns/entities/dns-zone.entity';
import { DnsZoneReplicaEntity } from '../modules/dns/entities/dns-zone-replica.entity';
import { ClusterDnsZoneEntity } from '../modules/dns/entities/cluster-dns-zone.entity';
import { AppEndpointEntity } from '../modules/dns/entities/app-endpoint.entity';
import { WildcardCertificateEntity } from '../modules/dns/entities/wildcard-certificate.entity';
import { SanCertificateEntity } from '../modules/dns/entities/san-certificate.entity';
import { ApplicationEntity } from '../modules/applications/entities/application.entity';
import { AppRevisionEntity } from '../modules/applications/entities/app-revision.entity';
import { AppResourceEntity } from '../modules/applications/entities/app-resource.entity';
import { AppBuildEntity } from '../modules/app-builds/entities/app-build.entity';
import { BuildCacheSnapshotEntity } from '../modules/app-builds/entities/build-cache-snapshot.entity';
import { UserEntity } from '../modules/auth/entities/user.entity';
import { RefreshTokenEntity } from '../modules/auth/entities/refresh-token.entity';
import { ApiKeyEntity } from '../modules/auth/entities/api-key.entity';
import { FrameworkBuildScoresEntity } from '../modules/frameworks/framework-core/entities/framework-build-scores.entity';
import { ImageEntity } from '../modules/image-registry/entities/image.entity';
import { CrashDiagnosisEntity } from '../modules/scaling/entities/crash-diagnosis.entity';
import { CatalogAppDefinitionEntity } from '../modules/catalog/entities/catalog-app-definition.entity';
import { CatalogInstallEntity } from '../modules/catalog/entities/catalog-install.entity';
import { ObjectStoreShareEntity } from '../modules/database-console/entities/object-store-share.entity';
import { ClusterAuthzInstallEntity } from '../modules/authz/entities/cluster-authz-install.entity';
import { BackupDestinationEntity } from '../modules/backups/entities/backup-destination.entity';
import { BackupPolicyEntity } from '../modules/backups/entities/backup-policy.entity';
import { BackupPolicyDestinationEntity } from '../modules/backups/entities/backup-policy-destination.entity';
import { BackupJobEntity } from '../modules/backups/entities/backup-job.entity';
import { BackupArtifactEntity } from '../modules/backups/entities/backup-artifact.entity';
import { BackupArtifactLocationEntity } from '../modules/backups/entities/backup-artifact-location.entity';
import { RestoreJobEntity } from '../modules/backups/entities/restore-job.entity';
import { InferenceConnectionEntity } from '../modules/inference/entities/inference-connection.entity';
import { AssistantMessageLogEntity } from '../modules/assistant/entities/assistant-message-log.entity';
import { McpToolCallLogEntity } from '../modules/mcp/entities/mcp-tool-call-log.entity';
import { IamRoleBindingEntity } from '../modules/iam/entities/iam-role-binding.entity';
import { IamGroupEntity } from '../modules/iam/entities/iam-group.entity';
import { ProjectEntity } from '../modules/projects/entities/project.entity';
import { DbReplicationLinkEntity } from '../modules/db-lifecycle/entities/db-replication-link.entity';
import { DbMigrationEntity } from '../modules/db-lifecycle/entities/db-migration.entity';
import { AppMigrationEntity } from '../modules/app-migration/entities/app-migration.entity';
import { FullMigrationEntity } from '../modules/full-migration/entities/full-migration.entity';
import { DemoConfigEntity } from '../modules/demo/entities/demo-config.entity';
import { AlertEventEntity } from '../modules/observability/entities/alert-event.entity';
import { MailSuppressionEntity } from '../modules/mail/entities/mail-suppression.entity';
import { MailEventEntity } from '../modules/mail/entities/mail-event.entity';
import { MailConnectionEntity } from '../modules/mail/entities/mail-connection.entity';

export const entities = [
  SSHKeyEntity,
  ProviderCredentialsEntity,
  ApiTokenEntity,
  ProviderConfigurationEntity,
  InfrastructureOperationEntity,
  ServerEntity,
  ClusterEntity,
  ClusterNodeEntity,
  NodeBillableIntervalEntity,
  VolumeBillableIntervalEntity,
  CAKeypairEntity,
  RepositoryEntity,
  RepositoryCredentialEntity,
  GitHubIntegrationConfigEntity,
  GitHubAppInstallationEntity,
  GithubUserTokenEntity,
  GithubAppManifestStateEntity,
  ClusterFirewallEntity,
  FirewallEntity,
  VNetEntity,
  VNetSubnetEntity,
  VNetRouteEntity,
  DnsZoneEntity,
  DnsZoneReplicaEntity,
  ClusterDnsZoneEntity,
  AppEndpointEntity,
  WildcardCertificateEntity,
  SanCertificateEntity,
  ApplicationEntity,
  AppRevisionEntity,
  AppResourceEntity,
  AppBuildEntity,
  BuildCacheSnapshotEntity,
  UserEntity,
  RefreshTokenEntity,
  ApiKeyEntity,
  FrameworkBuildScoresEntity,
  ImageEntity,
  CrashDiagnosisEntity,
  CatalogAppDefinitionEntity,
  CatalogInstallEntity,
  ObjectStoreShareEntity,
  ClusterAuthzInstallEntity,
  BackupDestinationEntity,
  BackupPolicyEntity,
  BackupPolicyDestinationEntity,
  BackupJobEntity,
  BackupArtifactEntity,
  BackupArtifactLocationEntity,
  RestoreJobEntity,
  InferenceConnectionEntity,
  AssistantMessageLogEntity,
  McpToolCallLogEntity,
  IamRoleBindingEntity,
  IamGroupEntity,
  ProjectEntity,
  DbReplicationLinkEntity,
  DbMigrationEntity,
  AppMigrationEntity,
  FullMigrationEntity,
  DemoConfigEntity,
  AlertEventEntity,
  MailSuppressionEntity,
  MailEventEntity,
  MailConnectionEntity,
];

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ObjectStoreShareEntity } from './entities/object-store-share.entity';
import { ObjectStoreShareRegistryService } from './services/object-store-share-registry.service';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { ApplicationsModule } from '../applications/applications.module';
import { AssistantModule } from '../assistant/assistant.module';
import { BackupsModule } from '../backups/backups.module';
import { StorageModule } from '../storage/storage.module';
import { DbConsoleController } from './controllers/db-console.controller';
import { KvConsoleController } from './controllers/kv-console.controller';
import { DocumentConsoleController } from './controllers/document-console.controller';
import { ObjectStoreConsoleController } from './controllers/object-store-console.controller';
import { ObjectStoreShareController } from './controllers/object-store-share.controller';
import { SearchConsoleController } from './controllers/search-console.controller';
import { MessagingConsoleController } from './controllers/messaging-console.controller';
import { CacheConsoleController } from './controllers/cache-console.controller';
import { SecretsConsoleController } from './controllers/secrets-console.controller';
import { KafkaConsoleController } from './controllers/kafka-console.controller';
import { FulltextConsoleController } from './controllers/fulltext-console.controller';
import { DB_CONNECTION_RESOLVER } from './interfaces/db-connection';
import { PostgresEngineAdapter } from './engine/postgres-engine.adapter';
import { MariadbEngineAdapter } from './engine/mariadb-engine.adapter';
import { RedisEngineAdapter } from './engine/redis-engine.adapter';
import { MongoEngineAdapter } from './engine/mongo-engine.adapter';
import { GarageS3Adapter } from './engine/garage-s3.adapter';
import { OpenSearchAdapter } from './engine/opensearch.adapter';
import { NatsAdapter } from './engine/nats.adapter';
import { RabbitMqAdapter } from './engine/rabbitmq.adapter';
import { MemcachedAdapter } from './engine/memcached.adapter';
import { OpenBaoAdapter } from './engine/openbao.adapter';
import { SQL_ENGINE_ADAPTERS } from './engine/sql-engine';
import { KV_ENGINE_ADAPTERS } from './engine/keyvalue-engine';
import { DOCUMENT_ENGINE_ADAPTERS } from './engine/document-engine';
import { OBJECT_STORE_ENGINE_ADAPTERS } from './engine/object-store-engine';
import { SEARCH_ENGINE_ADAPTERS } from './engine/search-engine';
import { MESSAGING_ENGINE_ADAPTERS } from './engine/messaging-engine';
import { CACHE_ENGINE_ADAPTERS } from './engine/cache-engine';
import { SECRETS_ENGINE_ADAPTERS } from './engine/secrets-engine';
import { EngineKnowledgeService } from './knowledge/engine-knowledge.service';
import { DbConsoleAuditService } from './services/db-console-audit.service';
import { DbQueryService } from './services/db-query.service';
import { DbAssistService } from './services/db-assist.service';
import { KvQueryService } from './services/kv-query.service';
import { KvAssistService } from './services/kv-assist.service';
import { DocumentQueryService } from './services/document-query.service';
import { DocumentAssistService } from './services/document-assist.service';
import { ObjectStoreQueryService } from './services/object-store-query.service';
import { ObjectStoreShareService } from './services/object-store-share.service';
import { ObjectStoreConnectionResolver } from './services/object-store-connection.resolver';
import { SearchQueryService } from './services/search-query.service';
import { SearchAssistService } from './services/search-assist.service';
import { SearchConnectionResolver } from './services/search-connection.resolver';
import { MessagingQueryService } from './services/messaging-query.service';
import { MessagingConnectionResolver } from './services/messaging-connection.resolver';
import { CacheQueryService } from './services/cache-query.service';
import { CacheConnectionResolver } from './services/cache-connection.resolver';
import { SecretsQueryService } from './services/secrets-query.service';
import { SecretsConnectionResolver } from './services/secrets-connection.resolver';
import { SecretsBootstrapService } from './services/secrets-bootstrap.service';
import { KafkaAdapter } from './engine/kafka.adapter';
import { KafkaConnectionResolver } from './services/kafka-connection.resolver';
import { KafkaQueryService } from './services/kafka-query.service';
import { KafkaAssistService } from './services/kafka-assist.service';
import { MeilisearchAdapter } from './engine/meilisearch.adapter';
import { FULLTEXT_ENGINE_ADAPTERS } from './engine/fulltext-engine';
import { FulltextConnectionResolver } from './services/fulltext-connection.resolver';
import { FulltextQueryService } from './services/fulltext-query.service';
import { FulltextAssistService } from './services/fulltext-assist.service';
import { KubePortForwardService } from './services/kube-port-forward.service';
import { OpenbaoUnsealScheduler } from './schedulers/openbao-unseal.scheduler';
import { OwnerSecretConnectionResolver } from './services/owner-secret-connection.resolver';
import { AppOwnershipGuard } from './guards/app-ownership.guard';
import { PlatformFoundationGuard } from './guards/platform-foundation.guard';
import { DbBackupController } from './controllers/db-backup.controller';
import { DbBackupService } from './services/db-backup.service';
import { DbDiskController } from './controllers/db-disk.controller';
import { DbDiskService } from './services/db-disk.service';
import { DbPitrController } from './controllers/db-pitr.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ObjectStoreShareEntity]),
    SharedInfrastructureModule,
    ClustersModule,
    ApplicationsModule,
    // Reuses the assistant's inference resolution + LLM transport for the SQL copilot.
    AssistantModule,
    // Logical DB backup → S3 destination: reuses backup-destinations (S3 creds) + storage backend.
    BackupsModule,
    StorageModule,
  ],
  controllers: [
    DbConsoleController,
    KvConsoleController,
    DocumentConsoleController,
    ObjectStoreConsoleController,
    ObjectStoreShareController,
    SearchConsoleController,
    MessagingConsoleController,
    CacheConsoleController,
    SecretsConsoleController,
    KafkaConsoleController,
    FulltextConsoleController,
    DbBackupController,
    DbDiskController,
    DbPitrController,
  ],
  providers: [
    AppOwnershipGuard,
    PlatformFoundationGuard,
    DbBackupService,
    DbDiskService,
    KubePortForwardService,
    PostgresEngineAdapter,
    MariadbEngineAdapter,
    RedisEngineAdapter,
    MongoEngineAdapter,
    GarageS3Adapter,
    OpenSearchAdapter,
    NatsAdapter,
    RabbitMqAdapter,
    MemcachedAdapter,
    OpenBaoAdapter,
    MeilisearchAdapter,
    // Registry of SQL engine adapters — add a new engine's adapter here and the
    // query layer picks it up by `.engine`, no switch to touch.
    {
      provide: SQL_ENGINE_ADAPTERS,
      useFactory: (pg: PostgresEngineAdapter, maria: MariadbEngineAdapter) => [
        pg,
        maria,
      ],
      inject: [PostgresEngineAdapter, MariadbEngineAdapter],
    },
    // Registry of key-value adapters (Redis/Valkey share one).
    {
      provide: KV_ENGINE_ADAPTERS,
      useFactory: (redis: RedisEngineAdapter) => [redis],
      inject: [RedisEngineAdapter],
    },
    // Registry of document adapters (the Mongo-wire adapter serves FerretDB + future Mongo).
    {
      provide: DOCUMENT_ENGINE_ADAPTERS,
      useFactory: (mongo: MongoEngineAdapter) => [mongo],
      inject: [MongoEngineAdapter],
    },
    // Registry of object-store adapters (the S3-wire adapter serves Garage + future MinIO/SeaweedFS).
    {
      provide: OBJECT_STORE_ENGINE_ADAPTERS,
      useFactory: (garage: GarageS3Adapter) => [garage],
      inject: [GarageS3Adapter],
    },
    // Registry of search adapters (the ES-wire adapter serves OpenSearch + future Elasticsearch).
    {
      provide: SEARCH_ENGINE_ADAPTERS,
      useFactory: (opensearch: OpenSearchAdapter) => [opensearch],
      inject: [OpenSearchAdapter],
    },
    // Registry of messaging adapters (NATS monitoring API + RabbitMQ management API).
    {
      provide: MESSAGING_ENGINE_ADAPTERS,
      useFactory: (nats: NatsAdapter, rabbit: RabbitMqAdapter) => [
        nats,
        rabbit,
      ],
      inject: [NatsAdapter, RabbitMqAdapter],
    },
    // Registry of cache adapters (Memcached ASCII protocol).
    {
      provide: CACHE_ENGINE_ADAPTERS,
      useFactory: (memcached: MemcachedAdapter) => [memcached],
      inject: [MemcachedAdapter],
    },
    // Registry of secrets adapters (OpenBao KV v2 over the Vault HTTP API).
    {
      provide: SECRETS_ENGINE_ADAPTERS,
      useFactory: (openbao: OpenBaoAdapter) => [openbao],
      inject: [OpenBaoAdapter],
    },
    // Registry of full-text adapters (Meilisearch native REST).
    {
      provide: FULLTEXT_ENGINE_ADAPTERS,
      useFactory: (meili: MeilisearchAdapter) => [meili],
      inject: [MeilisearchAdapter],
    },
    EngineKnowledgeService,
    DbConsoleAuditService,
    DbQueryService,
    DbAssistService,
    KvQueryService,
    KvAssistService,
    DocumentQueryService,
    DocumentAssistService,
    ObjectStoreQueryService,
    ObjectStoreShareService,
    ObjectStoreShareRegistryService,
    ObjectStoreConnectionResolver,
    SearchQueryService,
    SearchAssistService,
    SearchConnectionResolver,
    MessagingQueryService,
    MessagingConnectionResolver,
    CacheQueryService,
    CacheConnectionResolver,
    SecretsQueryService,
    SecretsConnectionResolver,
    SecretsBootstrapService,
    OpenbaoUnsealScheduler,
    // Kafka console: standalone multi-broker client lib + kafka-shell runner + copilot.
    KafkaAdapter,
    KafkaConnectionResolver,
    KafkaQueryService,
    KafkaAssistService,
    // Full-text console: Meilisearch (indexes + search + Dev Tools + copilot).
    FulltextConnectionResolver,
    FulltextQueryService,
    FulltextAssistService,
    OwnerSecretConnectionResolver,
    // Seam: swap this provider for a DedicatedUserConnectionResolver to move
    // from shared owner creds to per-Flui-user DB roles.
    {
      provide: DB_CONNECTION_RESOLVER,
      useClass: OwnerSecretConnectionResolver,
    },
  ],
  // DbBackupService is exported for the sandbox, which copies a reference
  // database into every new tenancy through the same logical dump and restore
  // the console offers — rather than growing a second way to move a database.
  exports: [DbQueryService, DbBackupService],
})
export class DatabaseConsoleModule {}

import { Module } from '@nestjs/common';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { ClustersModule } from '../infrastructure/clusters/clusters.module';
import { ApplicationsModule } from '../applications/applications.module';
import { AssistantModule } from '../assistant/assistant.module';
import { DbConsoleController } from './controllers/db-console.controller';
import { KvConsoleController } from './controllers/kv-console.controller';
import { DB_CONNECTION_RESOLVER } from './interfaces/db-connection';
import { PostgresEngineAdapter } from './engine/postgres-engine.adapter';
import { MariadbEngineAdapter } from './engine/mariadb-engine.adapter';
import { RedisEngineAdapter } from './engine/redis-engine.adapter';
import { SQL_ENGINE_ADAPTERS } from './engine/sql-engine';
import { KV_ENGINE_ADAPTERS } from './engine/keyvalue-engine';
import { EngineKnowledgeService } from './knowledge/engine-knowledge.service';
import { DbConsoleAuditService } from './services/db-console-audit.service';
import { DbQueryService } from './services/db-query.service';
import { DbAssistService } from './services/db-assist.service';
import { KvQueryService } from './services/kv-query.service';
import { KvAssistService } from './services/kv-assist.service';
import { KubePortForwardService } from './services/kube-port-forward.service';
import { OwnerSecretConnectionResolver } from './services/owner-secret-connection.resolver';

@Module({
  imports: [
    SharedInfrastructureModule,
    ClustersModule,
    ApplicationsModule,
    // Reuses the assistant's inference resolution + LLM transport for the SQL copilot.
    AssistantModule,
  ],
  controllers: [DbConsoleController, KvConsoleController],
  providers: [
    KubePortForwardService,
    PostgresEngineAdapter,
    MariadbEngineAdapter,
    RedisEngineAdapter,
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
    EngineKnowledgeService,
    DbConsoleAuditService,
    DbQueryService,
    DbAssistService,
    KvQueryService,
    KvAssistService,
    OwnerSecretConnectionResolver,
    // Seam: swap this provider for a DedicatedUserConnectionResolver to move
    // from shared owner creds to per-Flui-user DB roles.
    {
      provide: DB_CONNECTION_RESOLVER,
      useClass: OwnerSecretConnectionResolver,
    },
  ],
  exports: [DbQueryService],
})
export class DatabaseConsoleModule {}

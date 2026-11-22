import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { ApplicationsModule } from '../applications/applications.module';
import { DbLifecycleModule } from '../db-lifecycle/db-lifecycle.module';
import { EncryptionModule } from '../shared/encryption/encryption.module';
import { SharedInfrastructureModule } from '../infrastructure/shared/shared-infrastructure.module';
import { DbImportEntity } from './entities/db-import.entity';
import { DbImportService } from './services/db-import.service';
import { ExternalPgService } from './services/external-pg.service';
import { PgImportRunner } from './services/pg-import.runner';
import { MariadbImportRunner } from './services/mariadb-import.runner';
import { DbImportProcessor } from './processors/db-import.processor';
import { DbImportController } from './controllers/db-import.controller';
import { DB_IMPORT_QUEUE } from './db-import.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([DbImportEntity]),
    BullModule.registerQueue({ name: DB_IMPORT_QUEUE }),
    ApplicationsModule,
    DbLifecycleModule,
    EncryptionModule,
    SharedInfrastructureModule,
  ],
  controllers: [DbImportController],
  providers: [
    DbImportService,
    ExternalPgService,
    PgImportRunner,
    MariadbImportRunner,
    DbImportProcessor,
  ],
})
export class DbImportModule {}

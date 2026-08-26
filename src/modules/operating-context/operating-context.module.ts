import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OperatingContextEntryEntity } from './entities/operating-context-entry.entity';
import { OperatingContextController } from './operating-context.controller';
import { OperatingContextService } from './operating-context.service';
import { ContextProbeRegistry } from './probes/context-probe';
import { BuiltinProbes } from './probes/builtin-probes';
import { IamModule } from '../iam/iam.module';
import { READER_PLACEMENTS } from './placement/reader-placements';
import { ApplicationReaderPlacements } from './placement/application-placements';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ClusterEntity } from '../infrastructure/clusters/entities/cluster.entity';
import { UserEntity } from '../auth/entities/user.entity';
import { ENTRY_HANDS } from './hands/entry-hands';
import { UserEntryHands } from './hands/user-entry-hands';

/**
 * The third layer: knowledge.
 *
 * State is asked, never stored — which is why what this module reads from other
 * modules is three repositories, read-only and each behind a narrow port: two
 * so that a note can be *checked* against live state, behind an allow-list of
 * fields, and the identity directory so that a note can say whose it is,
 * behind a port that returns a name and cannot return an address. History is not
 * here either: it already exists as `mcp_tool_call_logs` and
 * `infrastructure_operations`. What is here is the part that ages, and the
 * machinery that makes it say so.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OperatingContextEntryEntity,
      ApplicationEntity,
      ClusterEntity,
      UserEntity,
    ]),
    IamModule,
  ],
  controllers: [OperatingContextController],
  providers: [
    OperatingContextService,
    ContextProbeRegistry,
    BuiltinProbes,
    { provide: READER_PLACEMENTS, useClass: ApplicationReaderPlacements },
    { provide: ENTRY_HANDS, useClass: UserEntryHands },
  ],
  exports: [OperatingContextService, ContextProbeRegistry],
})
export class OperatingContextModule {}

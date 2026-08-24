import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActionCycleController } from './action-cycle.controller';
import { ActionCycleService } from './action-cycle.service';
import { ActionProposalEntity } from './entities/action-proposal.entity';
import { AgentConcessionEntity } from './entities/agent-concession.entity';
import { InfrastructureOperationEntity } from '../infrastructure/servers/entities/infrastructure-operations.entity';

/**
 * The cycle's own module, holding an entity of the operations domain but none
 * of its services: the join it needs is a column, and importing the
 * infrastructure module to read one would tie the global guard chain to the
 * largest module in the product.
 *
 * `ActionCycleService` is exported because the guard is registered as an
 * `APP_GUARD` in `AppModule`, and a global guard resolves its dependencies from
 * there — the same arrangement `POLICY_ENGINE` already has with the two IAM
 * guards.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ActionProposalEntity,
      AgentConcessionEntity,
      InfrastructureOperationEntity,
    ]),
  ],
  controllers: [ActionCycleController],
  providers: [ActionCycleService],
  exports: [ActionCycleService],
})
export class ActionCycleModule {}

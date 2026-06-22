import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IamRoleBindingEntity } from './entities/iam-role-binding.entity';
import { IamGroupEntity } from './entities/iam-group.entity';
import { PolicyEngineService } from './services/policy-engine.service';
import { IamService } from './services/iam.service';
import { AccessPolicyService } from './services/access-policy.service';
import { POLICY_ENGINE } from './interfaces/policy-engine.interface';
import { IamController } from './controllers/iam.controller';
import { MeController } from './controllers/me.controller';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { UserEntity } from '../auth/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IamRoleBindingEntity,
      IamGroupEntity,
      ApplicationEntity,
      UserEntity,
    ]),
  ],
  controllers: [IamController, MeController],
  providers: [
    IamService,
    AccessPolicyService,
    { provide: POLICY_ENGINE, useClass: PolicyEngineService },
  ],
  exports: [POLICY_ENGINE, IamService],
})
export class IamModule {}

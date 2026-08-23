import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InfrastructureOperationsController } from './infrastructure-operations.controller';
import { InfrastructureOperationsService } from './infrastructure-operations.service';
import { InfrastructureOperationEntity } from '../servers/entities/infrastructure-operations.entity';
import { InfrastructureOperationsGateway } from './gateway/infrastructure-operations.gateway';
import { WsAuthModule } from '../../auth/ws-auth.module';
import { IamModule } from '../../iam/iam.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([InfrastructureOperationEntity]),
    WsAuthModule,
    // The route and the WebSocket room both ask whose operation it is, and the
    // answer needs the resolved section level as well as the row's owner.
    IamModule,
  ],
  controllers: [InfrastructureOperationsController],
  providers: [InfrastructureOperationsService, InfrastructureOperationsGateway],
  exports: [InfrastructureOperationsService, InfrastructureOperationsGateway],
})
export class InfrastructureOperationsModule {}

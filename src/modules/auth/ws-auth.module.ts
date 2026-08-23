import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { resolveJwtSecret } from './utils/jwt-secret.util';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './entities/user.entity';
import { ApiKeyEntity } from './entities/api-key.entity';
import { ApiKeyService } from './services/api-key.service';
import { ApiKeyStrategy } from './strategies/api-key.strategy';
import { WsAuthService } from './services/ws-auth.service';

/**
 * Lightweight module exposing JWT/API-key authentication for WebSocket
 * gateways. Kept separate from AuthModule to avoid pulling its heavy
 * transitive imports (ApplicationsModule, OidcModule, …) into every gateway.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([UserEntity, ApiKeyEntity]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: resolveJwtSecret(config),
        signOptions: { expiresIn: '15m', algorithm: 'HS256' },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [ApiKeyService, ApiKeyStrategy, WsAuthService],
  exports: [WsAuthService],
})
export class WsAuthModule {}

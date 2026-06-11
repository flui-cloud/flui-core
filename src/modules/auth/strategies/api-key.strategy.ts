import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKeyService } from '../services/api-key.service';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

@Injectable()
export class ApiKeyStrategy {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async validate(key: string): Promise<AuthenticatedUser> {
    const record = await this.apiKeyService.findValid(key);
    if (!record) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    if (record.userId) {
      const user = await this.userRepo.findOne({
        where: { id: record.userId },
      });
      if (user) {
        return {
          userId: user.id,
          email: user.email,
          roles: {},
          role: user.role ?? IdentityRole.USER,
          isAdmin: user.isAdmin,
          scopes: record.scopes ?? undefined,
        };
      }
    }

    return {
      userId: 'service-account',
      email: 'cli@flui.internal',
      roles: {},
      role: IdentityRole.ADMIN,
      isAdmin: true,
      scopes: record.scopes ?? undefined,
    };
  }
}

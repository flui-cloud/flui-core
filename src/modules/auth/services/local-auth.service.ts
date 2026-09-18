import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';
import { UserEntity } from '../entities/user.entity';
import { RefreshTokenEntity } from '../entities/refresh-token.entity';
import { LoginDto } from '../dto/login.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { UpdateMeDto } from '../dto/update-me.dto';
import { hashRefreshToken } from '../utils/refresh-token-hash.util';

const REFRESH_TOKEN_TTL_DAYS = 7;

/**
 * Stood in for a missing account's password hash, so the comparison costs the
 * same whether the address exists or not. A real bcrypt hash of a value nobody
 * holds — it can never match. It has to be well-formed or `compare` returns
 * early and the cost disappears with it, and it has to carry the same cost
 * factor the product hashes with (12, see `changePassword`) or the two paths
 * take measurably different times again.
 */
const ABSENT_ACCOUNT_HASH =
  '$2b$12$fNU.K9Wuy8x7afhXh.XxqecXcz9XFQ37sxd5SA88JEwlrP4ejSg1.';

@Injectable()
export class LocalAuthService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokenRepo: Repository<RefreshTokenEntity>,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    // Nothing about the attempt is logged, and that is the point: a line naming
    // the address, or distinguishing "no such user" from "wrong password", turns
    // whoever can read the logs into a holder of the account list.
    const user = await this.userRepo.findOne({ where: { email: dto.email } });

    // The comparison runs even when there is no such account, against a hash of
    // nothing. Identical wording is only half of not answering the question:
    // bcrypt at this cost takes a few hundred milliseconds, so skipping it on
    // the miss path times the difference out loud for anyone holding a stopwatch.
    const valid = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? ABSENT_ACCOUNT_HASH,
    );
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const access_token = this.generateToken(user);
    const refresh_token = await this.createRefreshToken(user.id);

    return {
      access_token,
      refresh_token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: user.isAdmin,
      },
    };
  }

  async refresh(token: string): Promise<{ access_token: string }> {
    const record = await this.refreshTokenRepo.findOne({
      where: { token: hashRefreshToken(token) },
    });

    if (!record || record.revoked || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.userRepo.findOne({ where: { id: record.userId } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return { access_token: this.generateToken(user) };
  }

  async logout(token: string): Promise<void> {
    await this.refreshTokenRepo.update(
      { token: hashRefreshToken(token) },
      { revoked: true },
    );
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    user.passwordHash = await bcrypt.hash(dto.newPassword, 12);
    await this.userRepo.save(user);

    // Revoke all refresh tokens for this user
    await this.refreshTokenRepo.update(
      { userId, revoked: false },
      { revoked: true },
    );
  }

  async updateMe(userId: string, dto: UpdateMeDto): Promise<UserEntity> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.name !== undefined) {
      user.name = dto.name;
    }

    return this.userRepo.save(user);
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const token = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

    await this.refreshTokenRepo.save({
      token: hashRefreshToken(token),
      userId,
      expiresAt,
      revoked: false,
    });

    // Clean up expired tokens for this user (non-blocking)
    this.refreshTokenRepo
      .delete({ userId, expiresAt: LessThan(new Date()) })
      .catch(() => {});

    return token;
  }

  private generateToken(user: UserEntity): string {
    return this.jwtService.sign({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
    });
  }
}

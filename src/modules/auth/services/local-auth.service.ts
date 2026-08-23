import {
  Injectable,
  Logger,
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

const REFRESH_TOKEN_TTL_DAYS = 7;

@Injectable()
export class LocalAuthService {
  private readonly logger = new Logger(LocalAuthService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokenRepo: Repository<RefreshTokenEntity>,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto) {
    this.logger.log(`Login attempt for: ${dto.email}`);

    const user = await this.userRepo.findOne({ where: { email: dto.email } });
    if (!user) {
      this.logger.warn(`Login failed: user not found (${dto.email})`);
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.log(
      `User found: ${user.email} | passwordHash present: ${!!user.passwordHash} | hash prefix: ${user.passwordHash?.substring(0, 7)}`,
    );

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    this.logger.log(`Password valid: ${valid}`);
    if (!valid) {
      this.logger.warn(`Login failed: wrong password for ${dto.email}`);
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
    const record = await this.refreshTokenRepo.findOne({ where: { token } });

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
    await this.refreshTokenRepo.update({ token }, { revoked: true });
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
      token,
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

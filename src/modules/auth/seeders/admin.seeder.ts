import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'node:crypto';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IAM_ROLE } from '../../iam/constants/iam-roles';

const GENERATED_PASSWORD_LENGTH = 24;
const SAFE_CHARSET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generatePassword(): string {
  const bytes = crypto.randomBytes(GENERATED_PASSWORD_LENGTH);
  let result = '';
  for (let i = 0; i < GENERATED_PASSWORD_LENGTH; i++) {
    result += SAFE_CHARSET[bytes[i] % SAFE_CHARSET.length];
  }
  return result;
}

@Injectable()
export class AdminSeeder implements OnModuleInit {
  private readonly logger = new Logger(AdminSeeder.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindingRepo: Repository<IamRoleBindingEntity>,
  ) {}

  async onModuleInit() {
    if (process.env.AUTH_MODE !== 'local') {
      return;
    }

    const email =
      this.configService.get<string>('ADMIN_EMAIL') || 'admin@flui.cloud';

    const exists = await this.userRepo.findOne({ where: { email } });
    if (exists) {
      this.logger.log(`✅ Admin already exists: ${email}`);
      return;
    }

    const providedPassword = this.configService.get<string>('ADMIN_PASSWORD');
    const password = providedPassword || generatePassword();
    const isGenerated = !providedPassword;

    const passwordHash = await bcrypt.hash(password, 12);
    await this.userRepo.save({
      email,
      passwordHash,
      name: 'Admin',
      isAdmin: true,
      role: IdentityRole.ADMIN,
    });

    // The account's power, said in the way IAM can read. The boolean above is
    // still what the guards look at today, but it is on its way out, and a
    // fresh installation seeded without this binding would be the very state the
    // backfill migration exists to repair — created new, one release later.
    await this.bindingRepo.save(
      this.bindingRepo.create({
        principalType: 'user',
        principalRef: email,
        role: IAM_ROLE.OWNER,
        scopeType: 'global',
        scopeRef: null,
        selector: null,
      }),
    );

    if (isGenerated) {
      this.logger.warn('━'.repeat(60));
      this.logger.warn('🌱 Admin user created with GENERATED credentials:');
      this.logger.warn(`   Email:    ${email}`);
      this.logger.warn(`   Password: ${password}`);
      this.logger.warn('   ⚠️  Save these credentials — shown only once!');
      this.logger.warn('━'.repeat(60));
    } else {
      this.logger.log(`🌱 Admin user created: ${email}`);
    }
  }
}

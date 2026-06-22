import { Injectable, NotImplementedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IdentityRole, UserEntity } from '../entities/user.entity';
import {
  CreateIdentityUserInput,
  CreatedIdentityUser,
  IIdentityDirectory,
  IdentityUser,
  InviteLink,
  ListIdentityUsersQuery,
} from '../interfaces/identity-directory.interface';

const NOT_IMPLEMENTED =
  'Multi-user management is not implemented for AUTH_MODE=local yet';

/**
 * Local-mode placeholder. Read endpoints expose the local users table; write
 * operations throw 501 until a local invite/credential-management flow exists.
 */
@Injectable()
export class LocalIdentityDirectory implements IIdentityDirectory {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async listUsers(query?: ListIdentityUsersQuery): Promise<IdentityUser[]> {
    const qb = this.userRepo
      .createQueryBuilder('u')
      .orderBy('u.createdAt', 'ASC')
      .take(query?.limit ?? 100)
      .skip(query?.offset ?? 0);
    if (query?.emailContains) {
      qb.andWhere('u.email ILIKE :q', { q: `%${query.emailContains}%` });
    }
    const rows = await qb.getMany();
    return rows.map((u) => this.toIdentityUser(u));
  }

  async getUser(id: string): Promise<IdentityUser | null> {
    const u = await this.userRepo.findOne({ where: { id } });
    return u ? this.toIdentityUser(u) : null;
  }

  createUser(_: CreateIdentityUserInput): Promise<CreatedIdentityUser> {
    throw new NotImplementedException(NOT_IMPLEMENTED);
  }
  deleteUser(_: string): Promise<void> {
    throw new NotImplementedException(NOT_IMPLEMENTED);
  }
  setRole(_: string, __: IdentityRole): Promise<void> {
    throw new NotImplementedException(NOT_IMPLEMENTED);
  }
  resetPassword(
    _: string,
    __: boolean,
  ): Promise<{
    tempPassword?: string;
    inviteLink?: string;
    inviteCode?: string;
  }> {
    throw new NotImplementedException(NOT_IMPLEMENTED);
  }
  createInviteLink(_: string): Promise<InviteLink> {
    throw new NotImplementedException(NOT_IMPLEMENTED);
  }

  private toIdentityUser(u: UserEntity): IdentityUser {
    const expectedAdmin = (
      process.env.ADMIN_EMAIL || 'admin@flui.cloud'
    ).toLowerCase();
    return {
      id: u.id,
      email: u.email,
      firstName: u.name ?? undefined,
      role: u.role ?? (u.isAdmin ? IdentityRole.ADMIN : IdentityRole.USER),
      isBootstrapAdmin: u.email.toLowerCase() === expectedAdmin,
      isSystemUser: false,
    };
  }
}

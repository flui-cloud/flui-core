import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity, IdentityRole } from '../entities/user.entity';
import {
  CreateIdentityUserInput,
  CreatedIdentityUser,
  IDENTITY_DIRECTORY,
  IIdentityDirectory,
  IdentityUser,
  InviteLink,
  ListIdentityUsersQuery,
} from '../interfaces/identity-directory.interface';

@Injectable()
export class UserManagementService {
  constructor(
    @Inject(IDENTITY_DIRECTORY)
    private readonly directory: IIdentityDirectory,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  createUser(input: CreateIdentityUserInput): Promise<CreatedIdentityUser> {
    return this.directory.createUser(input);
  }

  listUsers(query?: ListIdentityUsersQuery): Promise<IdentityUser[]> {
    return this.directory.listUsers(query);
  }

  getUser(id: string): Promise<IdentityUser | null> {
    return this.directory.getUser(id);
  }

  async deleteUser(id: string, callerUserId: string): Promise<void> {
    const target = await this.directory.getUser(id);
    if (!target) throw new NotFoundException(`User ${id} not found`);
    if (target.isSystemUser) {
      throw new ConflictException(
        'Cannot delete the system user provisioned by the OIDC provider',
      );
    }
    if (target.isBootstrapAdmin) {
      throw new ConflictException('Cannot delete the bootstrap admin');
    }
    const callerLocal = await this.userRepo.findOne({
      where: { id: callerUserId },
    });
    if (callerLocal?.oidcSub === id || callerLocal?.id === id) {
      throw new ConflictException('Cannot delete your own account');
    }
    await this.directory.deleteUser(id);
  }

  async setRole(
    id: string,
    role: IdentityRole,
    callerUserId: string,
  ): Promise<void> {
    const target = await this.directory.getUser(id);
    if (!target) throw new NotFoundException(`User ${id} not found`);
    const callerLocal = await this.userRepo.findOne({
      where: { id: callerUserId },
    });
    if (
      role !== IdentityRole.ADMIN &&
      (callerLocal?.oidcSub === id || callerLocal?.id === id)
    ) {
      throw new ConflictException(
        'Cannot demote yourself — ask another admin to change your role',
      );
    }
    await this.directory.setRole(id, role);
  }

  resetPassword(
    id: string,
    sendInvite: boolean,
  ): Promise<{
    tempPassword?: string;
    inviteLink?: string;
    inviteCode?: string;
  }> {
    return this.directory.resetPassword(id, sendInvite);
  }

  createInviteLink(id: string): Promise<InviteLink> {
    return this.directory.createInviteLink(id);
  }
}

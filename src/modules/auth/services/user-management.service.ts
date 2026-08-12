import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity, IdentityRole } from '../entities/user.entity';
import { InviteMailService } from '../../mail/services/invite-mail.service';
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
    private readonly inviteMail: InviteMailService,
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

  /**
   * Mint an invite link, and optionally deliver it.
   *
   * The link is the product; the email is a convenience. So delivery is opt-in,
   * its outcome is *reported* rather than thrown, and the link comes back
   * either way — an administrator who can paste it into a chat window is never
   * left worse off by a mailer problem than they were before email existed.
   *
   * Note that generating a link **rotates** the provider's code, invalidating
   * any previous one. That is why this does not quietly retry on a failed send:
   * a second attempt would hand out a link that supersedes the one already on
   * its way.
   */
  async createInviteLink(
    id: string,
    options: { send?: boolean; invitedBy?: string } = {},
  ): Promise<InviteLink & { delivery?: { sent: boolean; reason?: string } }> {
    const link = await this.directory.createInviteLink(id);
    if (!options.send)
      return { ...link, delivery: { sent: false, reason: 'not_requested' } };

    const user = await this.directory.getUser(id);
    if (!user?.email) {
      return { ...link, delivery: { sent: false, reason: 'no_address' } };
    }

    const outcome = await this.inviteMail.sendInvite({
      to: user.email,
      inviteLink: link.inviteLink,
      ...(user.firstName ? { firstName: user.firstName } : {}),
      ...(options.invitedBy ? { invitedBy: options.invitedBy } : {}),
    });
    return {
      ...link,
      delivery: {
        sent: outcome.sent,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
    };
  }
}

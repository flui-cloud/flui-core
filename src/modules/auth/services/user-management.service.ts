import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../entities/user.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IamGroupEntity } from '../../iam/entities/iam-group.entity';
import { ApiKeyService } from './api-key.service';
import { AssignableIdentityRole } from '../constants/assignable-roles';
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
  private readonly logger = new Logger(UserManagementService.name);

  constructor(
    @Inject(IDENTITY_DIRECTORY)
    private readonly directory: IIdentityDirectory,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @InjectRepository(IamGroupEntity)
    private readonly groups: Repository<IamGroupEntity>,
    private readonly apiKeys: ApiKeyService,
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
    await this.detachLocalAccess(id);
  }

  /**
   * Every IAM role binding that named this person — and a binding can name them
   * two ways.
   *
   * `principalRef` is an email for a human and a local id for a service
   * account, so a single `delete({ principalRef: email })` removes one of the
   * two kinds and silently leaves the other. That matters more than a stale
   * row: a surviving binding is a permission with no holder, and the day
   * somebody invites that address again the old grants attach themselves to a
   * new human being.
   *
   * Public, and called from both places that take a person apart — the
   * administrative delete above and the sandbox reaper. The two used to write
   * this cleanup separately and one of them was already narrower; two routines
   * with the same purpose diverge at the first change to either.
   */
  async detachRoleBindings(principal: {
    id?: string | null;
    email: string;
  }): Promise<number> {
    const byEmail = await this.bindings.delete({
      principalType: 'user',
      principalRef: principal.email,
    });
    // Guarded, not merged into one call: a `delete` with an undefined criterion
    // is a delete of everything.
    const byServiceAccount = principal.id
      ? await this.bindings.delete({
          principalType: 'service_account',
          principalRef: principal.id,
        })
      : { affected: 0 };
    return (byEmail.affected ?? 0) + (byServiceAccount.affected ?? 0);
  }

  /**
   * Everything on Flui's side that still pointed at the person the identity
   * provider has just stopped knowing.
   *
   * Until now this method did exactly one thing — delete the account upstream —
   * and left three kinds of residue behind, of which only the first was ever
   * noticed:
   *
   *  - **API keys.** Orphan rows for ever. Not live (`ApiKeyStrategy` refuses a
   *    key whose owner is gone), but the accumulation decision 66 had to sweep
   *    by hand came from exactly this shape of path. They are **revoked, not
   *    deleted**: a closed row is still evidence, a missing one is not.
   *  - **Role bindings.** The dangerous one, and worse than a dead key: a
   *    binding names a person by *email*, so it is a permission with no holder
   *    — and the day somebody invites that address again, the old grants
   *    silently attach themselves to a new human being. Deleted, not kept.
   *  - **Group membership.** The same reattachment by another door. Removed.
   *
   * The local `users` row deliberately stays. Deleting a person must not delete
   * their applications, and every one of those rows points at this id — the
   * sandbox reaper may delete its row only because it destroys the tenancy's
   * applications first. What goes is the `oidcSub` link, because the account it
   * mirrored no longer exists and a mapping to a deleted account is a mapping
   * that lies.
   */
  private async detachLocalAccess(idpUserId: string): Promise<void> {
    const local = await this.userRepo.findOne({
      where: [{ oidcSub: idpUserId }, { id: idpUserId }],
    });
    if (!local) return;

    const revoked = await this.apiKeys.revokeAllForUser(local.id);
    const bindingCount = await this.detachRoleBindings(local);
    const groups = await this.groups.find();
    let removedFrom = 0;
    for (const group of groups) {
      if (!group.members?.includes(local.email)) continue;
      group.members = group.members.filter((m) => m !== local.email);
      await this.groups.save(group);
      removedFrom += 1;
    }
    if (local.oidcSub) {
      await this.userRepo.update({ id: local.id }, { oidcSub: null });
    }

    this.logger.log(
      `Deleted account ${local.email}: revoked ${revoked} API key(s), ` +
        `removed ${bindingCount} role binding(s) and membership of ${removedFrom} group(s); ` +
        'the local row is kept because the resources it owns still point at it.',
    );
  }

  /**
   * `role` is narrowed to the assignable set: platform admin is not conferrable
   * from here, and the compiler — not a runtime check — is what says so.
   */
  async setRole(
    id: string,
    role: AssignableIdentityRole,
    callerUserId: string,
  ): Promise<void> {
    const target = await this.directory.getUser(id);
    if (!target) throw new NotFoundException(`User ${id} not found`);
    const callerLocal = await this.userRepo.findOne({
      where: { id: callerUserId },
    });
    if (callerLocal?.oidcSub === id || callerLocal?.id === id) {
      throw new ConflictException(
        'Cannot change your own role — ask another admin to change it',
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

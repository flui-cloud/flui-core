import { IdentityRole } from '../entities/user.entity';

export const IDENTITY_DIRECTORY = 'IDENTITY_DIRECTORY';

export interface CreateIdentityUserInput {
  email: string;
  firstName: string;
  lastName: string;
  sendInvite: boolean;
  tempPassword?: string;
  role?: IdentityRole;
}

export interface CreatedIdentityUser {
  id: string;
  email: string;
  role: IdentityRole;
  tempPassword?: string;
  inviteLink?: string;
  inviteCode?: string;
}

/**
 * A ready-to-share invite link plus the raw provider code. The link path is
 * environment-configurable (OIDC_INVITE_LINK_TEMPLATE); the code is the
 * authoritative value to fall back on if the link path needs adjusting.
 */
export interface InviteLink {
  inviteLink: string;
  inviteCode: string;
  userId: string;
  organizationId?: string;
}

export interface IdentityUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: IdentityRole;
  state?: string;
  isBootstrapAdmin: boolean;
  isSystemUser: boolean;
}

export interface ListIdentityUsersQuery {
  limit?: number;
  offset?: number;
  emailContains?: string;
}

export interface IIdentityDirectory {
  createUser(input: CreateIdentityUserInput): Promise<CreatedIdentityUser>;
  listUsers(query?: ListIdentityUsersQuery): Promise<IdentityUser[]>;
  getUser(id: string): Promise<IdentityUser | null>;
  deleteUser(id: string): Promise<void>;
  setRole(id: string, role: IdentityRole): Promise<void>;
  resetPassword(
    id: string,
    sendInvite: boolean,
  ): Promise<{
    tempPassword?: string;
    inviteLink?: string;
    inviteCode?: string;
  }>;
  createInviteLink(id: string): Promise<InviteLink>;
}

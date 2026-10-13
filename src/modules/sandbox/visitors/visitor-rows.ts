import { EntityManager } from 'typeorm';
import { randomBytes } from 'node:crypto';
import {
  IdentityRole,
  USER_KIND,
  UserEntity,
} from '../../auth/entities/user.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { IAM_ROLE } from '../../iam/constants/iam-roles';
import { SHOWCASE_GRANT } from '../../iam/constants/iam-showcase';
import { VISITOR_EMAIL_DOMAIN } from '../../auth/utils/placeholder-email.util';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';

/** The identity-provider name of a visitor, derived from an id chosen before it exists. */
export function visitorIdentity(seed: string): {
  userName: string;
  email: string;
} {
  const userName = `visitor-${seed.replace(/-/g, '').slice(0, 8)}`;
  return { userName, email: `${userName}@${VISITOR_EMAIL_DOMAIN}` };
}

/**
 * Meets any password policy the identity provider may enforce. Used once to
 * open the visitor's session and then forgotten: nobody ever types it.
 */
export function throwawayPassword(): string {
  return `${randomBytes(24).toString('base64url')}aA1!`;
}

/**
 * The local visitor: a person of kind `visitor`, its read-only demo role, the
 * showcase grant, and the row only a visitor has. One function for every way a
 * visitor comes in, so they can never be made differently.
 */
export async function writeVisitorRows(
  m: EntityManager,
  params: { idpUserId: string; email: string; ipHash: string | null },
): Promise<string> {
  const users = m.getRepository(UserEntity);
  const user = await users.save(
    users.create({
      email: params.email,
      oidcSub: params.idpUserId,
      role: IdentityRole.USER,
      isAdmin: false,
      passwordHash: null,
      displayName: 'Visitor',
      kind: USER_KIND.VISITOR,
    }),
  );
  const bindings = m.getRepository(IamRoleBindingEntity);
  await bindings.save([
    bindings.create({
      principalType: 'user',
      principalRef: user.id,
      role: IAM_ROLE.SANDBOX_VISITOR,
      scopeType: 'selector',
      scopeRef: null,
      selector: { owner: user.id },
    }),
    bindings.create({
      principalType: 'user',
      principalRef: user.id,
      role: SHOWCASE_GRANT.role,
      scopeType: 'selector',
      scopeRef: null,
      selector: SHOWCASE_GRANT.selector,
    }),
  ]);
  await m.getRepository(SandboxVisitorEntity).save({
    userId: user.id,
    idpUserId: params.idpUserId,
    ipHash: params.ipHash,
  });
  return user.id;
}

import { EntityManager } from 'typeorm';
import { USER_KIND, UserEntity } from '../../auth/entities/user.entity';
import { ApiKeyEntity } from '../../auth/entities/api-key.entity';
import { IamRoleBindingEntity } from '../../iam/entities/iam-role-binding.entity';
import { InferenceUsageEventEntity } from '../../inference/entities/inference-usage-event.entity';
import { ActionProposalEntity } from '../../action-cycle/entities/action-proposal.entity';
import { AgentConcessionEntity } from '../../action-cycle/entities/agent-concession.entity';
import { SandboxGuestEnrolment } from '../gate/sandbox-guest-enrolment';
import { SandboxVisitorEntity } from '../entities/sandbox-visitor.entity';
import { accessGrantsChanged } from '../../iam/services/access-grants-changed';

export interface VisitorProfileChange {
  /** A proven address only; null keeps the placeholder. */
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
}

/** The visitor, locked for the change; null when it is no longer a visitor. */
export async function lockVisitor(
  m: EntityManager,
  userId: string,
): Promise<UserEntity | null> {
  return m.getRepository(UserEntity).findOne({
    where: { id: userId, kind: USER_KIND.VISITOR },
    lock: { mode: 'pessimistic_write' },
  });
}

/**
 * The visitor becomes a person on the same row, so its sub, keys and ledger
 * carry over. It loses the visitor's roles and is enrolled like anybody signing
 * in for the first time, which leaves an invited address to its invitation.
 * Its keys keep the read-only scopes they were minted with.
 */
export async function flipVisitorToPerson(
  m: EntityManager,
  enrolment: SandboxGuestEnrolment,
  visitor: UserEntity,
  change: VisitorProfileChange,
  now: Date,
): Promise<{ guest: boolean }> {
  visitor.kind = USER_KIND.PERSON;
  if (change.email) visitor.email = change.email;
  visitor.firstName = change.firstName;
  visitor.lastName = change.lastName;
  visitor.displayName = change.displayName ?? visitor.displayName;
  visitor.name = visitor.displayName ?? visitor.name;
  visitor.profileSyncedAt = now;
  await m.getRepository(UserEntity).save(visitor);
  await m
    .getRepository(IamRoleBindingEntity)
    .delete({ principalType: 'user', principalRef: visitor.id });
  const guest = await enrolment.enrol(
    {
      userId: visitor.id,
      email: change.email,
      hasProviderRoles: false,
      kind: USER_KIND.PERSON,
    },
    m,
  );
  await m
    .getRepository(SandboxVisitorEntity)
    .update({ userId: visitor.id }, { upgradedAt: now });
  return { guest };
}

/**
 * The visitor is merged into an existing account: what it made moves there,
 * its own roles and row go, and the visitor row stays as the record of where it
 * went. The identity provider's account is removed by the caller afterwards.
 */
export async function foldVisitorInto(
  m: EntityManager,
  visitor: UserEntity,
  targetUserId: string,
  now: Date,
): Promise<void> {
  const from = visitor.id;
  await m
    .getRepository(ApiKeyEntity)
    .update({ userId: from }, { userId: targetUserId });
  await m
    .getRepository(InferenceUsageEventEntity)
    .update({ userId: from }, { userId: targetUserId });
  await m
    .getRepository(ActionProposalEntity)
    .update({ ownerUserId: from }, { ownerUserId: targetUserId });
  await m
    .getRepository(AgentConcessionEntity)
    .update({ ownerUserId: from }, { ownerUserId: targetUserId });
  await m
    .getRepository(IamRoleBindingEntity)
    .delete({ principalType: 'user', principalRef: from });
  accessGrantsChanged();
  await m
    .getRepository(SandboxVisitorEntity)
    .update({ userId: from }, { upgradedAt: now, linkedUserId: targetUserId });
  await m
    .getRepository(UserEntity)
    .delete({ id: from, kind: USER_KIND.VISITOR });
}

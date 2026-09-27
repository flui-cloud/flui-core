import { Repository } from 'typeorm';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';

function coveringPolicies(
  policies: Repository<BackupPolicyEntity>,
  applicationId: string,
) {
  return policies
    .createQueryBuilder('p')
    .where(`p."scopeSelector"->'applicationIds' @> :ids::jsonb`, {
      ids: JSON.stringify([applicationId]),
    })
    .andWhere('p.enabled = true');
}

/**
 * A policy whose application is gone protects nothing, and left "active" it is
 * counted as protection and runs against a source that is not there. It is
 * stopped and marked, never deleted: its backups stay restorable for as long
 * as their retention keeps them.
 */
export async function closePoliciesOfDeletedApplication(
  policies: Repository<BackupPolicyEntity>,
  app: { id: string; name: string },
  now = new Date(),
): Promise<number> {
  const covering = await coveringPolicies(policies, app.id).getMany();
  for (const policy of covering) {
    policy.enabled = false;
    policy.status = BackupPolicyStatus.PAUSED;
    policy.metadata = {
      ...policy.metadata,
      sourceDeleted: {
        at: now.toISOString(),
        applicationId: app.id,
        applicationName: app.name,
      },
    };
    await policies.save(policy);
  }
  return covering.length;
}

/**
 * The sentence a removal shows about backups: what stops, and that what was
 * already saved stays and can be restored after the removal.
 */
export async function describeBackupsAfterRemoval(
  policies: Repository<BackupPolicyEntity>,
  artifacts: Repository<BackupArtifactEntity>,
  applicationIds: string[],
): Promise<string | null> {
  let active = 0;
  for (const id of applicationIds) {
    active += await coveringPolicies(policies, id).getCount();
  }
  if (!applicationIds.length) return null;
  const latest = await artifacts
    .createQueryBuilder('a')
    .where(
      `(a."applicationId"::text IN (:...ids) OR a."manifestSummary"->>'applicationId' IN (:...ids))`,
      { ids: applicationIds },
    )
    .orderBy('a.createdAt', 'DESC')
    .getOne();
  if (!latest && !active) return null;
  const parts: string[] = [];
  if (latest) {
    const kept = latest.expiresAt
      ? ` until ${latest.expiresAt.toISOString().slice(0, 10)}`
      : ' until its retention removes it';
    parts.push(
      `Backups already taken stay in the backup storage and can be restored after this (latest ${latest.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC, kept${kept}).`,
    );
  }
  if (active) {
    const stops =
      active === 1 ? 'backup policy stops' : active + ' backup policies stop';
    parts.push(`Its ${stops}; nothing new is backed up.`);
  }
  return parts.join(' ');
}

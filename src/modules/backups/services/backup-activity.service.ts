import { Injectable } from '@nestjs/common';
import { BackupPoliciesService } from './backup-policies.service';
import { BackupJobRepository } from '../repositories/backup-job.repository';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupPolicyEntity } from '../entities/backup-policy.entity';
import { BackupJobEntity } from '../entities/backup-job.entity';
import {
  ActivityArtifact,
  BackupPolicyActivity,
  buildPolicyActivity,
  clampActivityLimit,
} from '../utils/backup-activity.util';

/** Enough history to judge health when the caller asks for no runs. */
const HEALTH_WINDOW = 20;

@Injectable()
export class BackupActivityService {
  constructor(
    private readonly policies: BackupPoliciesService,
    private readonly jobs: BackupJobRepository,
    private readonly artifacts: BackupArtifactRepository,
  ) {}

  async forPolicy(
    policyId: string,
    limit?: unknown,
    now: Date = new Date(),
  ): Promise<BackupPolicyActivity> {
    const policy = await this.policies.findById(policyId);
    return this.build(policy, clampActivityLimit(limit), true, now);
  }

  async forUser(
    userId: string,
    now: Date = new Date(),
  ): Promise<BackupPolicyActivity[]> {
    const policies = await this.policies.list(userId);
    return Promise.all(policies.map((p) => this.build(p, 0, false, now)));
  }

  private async build(
    policy: BackupPolicyEntity,
    limit: number,
    withRuns: boolean,
    now: Date,
  ): Promise<BackupPolicyActivity> {
    const recent = await this.jobs.findByPolicy(
      policy.id,
      Math.max(limit, HEALTH_WINDOW),
    );
    const lastCompleted = await this.jobs.findLastCompletedByPolicy(policy.id);
    const jobs =
      lastCompleted && !recent.some((j) => j.id === lastCompleted.id)
        ? [...recent, lastCompleted]
        : recent;

    const artifactsByJob = await this.artifactsFor(
      this.jobsNeedingArtifacts(jobs, limit, withRuns),
    );
    return buildPolicyActivity(
      policy,
      jobs,
      artifactsByJob,
      now,
      withRuns ? limit : 0,
    );
  }

  /**
   * The runs that are shown, plus the newest finished one: whether a partial
   * run captured anything is read off its artifacts.
   */
  private jobsNeedingArtifacts(
    jobs: BackupJobEntity[],
    limit: number,
    withRuns: boolean,
  ): string[] {
    const ids = new Set<string>();
    if (jobs[0]) ids.add(jobs[0].id);
    if (withRuns) jobs.slice(0, limit).forEach((j) => ids.add(j.id));
    const finished = jobs.find((j) =>
      ['completed', 'partially_completed', 'failed'].includes(j.status),
    );
    if (finished) ids.add(finished.id);
    return [...ids];
  }

  private async artifactsFor(
    jobIds: string[],
  ): Promise<Map<string, ActivityArtifact[]>> {
    const rows = await this.artifacts.listByJobs(jobIds);
    const byJob = new Map<string, ActivityArtifact[]>();
    for (const a of rows) {
      const list = byJob.get(a.backupJobId) ?? [];
      list.push(a);
      byJob.set(a.backupJobId, list);
    }
    return byJob;
  }
}

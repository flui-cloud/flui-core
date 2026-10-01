interface RecentJob {
  id: string;
  policyId?: string | null;
  status: string;
  createdAt: Date;
}

const FAILED = new Set(['failed', 'cancelled']);

/**
 * Failed runs still worth a word: a policy counts only while its newest run
 * failed, since a later success has already answered the failure. A run no
 * policy owns counts on its own.
 */
export function unresolvedFailures(jobs: RecentJob[]): number {
  const newestByPolicy = new Map<string, RecentJob>();
  let adHoc = 0;
  for (const job of jobs) {
    if (!job.policyId) {
      if (FAILED.has(job.status)) adHoc++;
      continue;
    }
    const seen = newestByPolicy.get(job.policyId);
    if (!seen || job.createdAt > seen.createdAt) {
      newestByPolicy.set(job.policyId, job);
    }
  }
  const policies = [...newestByPolicy.values()].filter((j) =>
    FAILED.has(j.status),
  ).length;
  return policies + adHoc;
}

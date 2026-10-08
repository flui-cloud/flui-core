import {
  isRefusedEmail,
  loadSandboxConfig,
  podSecurityLabels,
  refusedEmailDomains,
  workloadDeadline,
} from './sandbox.config';

describe('sandbox pod security', () => {
  it('defaults to baseline', () => {
    expect(loadSandboxConfig({}).podSecurity).toBe('baseline');
  });

  it('takes a known level from the environment', () => {
    expect(
      loadSandboxConfig({ SANDBOX_POD_SECURITY: 'restricted' }).podSecurity,
    ).toBe('restricted');
  });

  it('ignores a level that does not exist rather than enforcing nothing', () => {
    expect(
      loadSandboxConfig({ SANDBOX_POD_SECURITY: 'strict' }).podSecurity,
    ).toBe('baseline');
  });

  it('labels the namespace to enforce and warn at the same level', () => {
    expect(podSecurityLabels('restricted')).toEqual({
      'pod-security.kubernetes.io/enforce': 'restricted',
      'pod-security.kubernetes.io/warn': 'restricted',
    });
  });
});

describe('sandbox thresholds from the environment', () => {
  it('caps a guest area at two cores unless told otherwise', () => {
    expect(loadSandboxConfig({}).quota.cpuLimit).toBe('2');
    expect(
      loadSandboxConfig({ SANDBOX_QUOTA_CPU_LIMIT: '4' }).quota.cpuLimit,
    ).toBe('4');
  });

  it('reads every quota field from its own variable', () => {
    const quota = loadSandboxConfig({
      SANDBOX_QUOTA_MEMORY_LIMIT: '3Gi',
      SANDBOX_QUOTA_NODE_DISK: '5Gi',
      SANDBOX_QUOTA_PODS: '20',
      SANDBOX_QUOTA_CONTAINER_MAX_CPU: '500m',
    }).quota;

    expect(quota.memoryLimit).toBe('3Gi');
    expect(quota.nodeLocalCeiling).toBe('5Gi');
    expect(quota.pods).toBe(20);
    expect(quota.maxContainerCpu).toBe('500m');
  });

  it('keeps the default when a value is not a quantity, so a typo never removes a ceiling', () => {
    const quota = loadSandboxConfig({
      SANDBOX_QUOTA_MEMORY_LIMIT: 'lots',
      SANDBOX_QUOTA_PODS: '2.5',
    }).quota;

    expect(quota.memoryLimit).toBe('6Gi');
    expect(quota.pods).toBe(12);
  });

  it('reads the refill and teardown knobs', () => {
    const config = loadSandboxConfig({
      SANDBOX_MAX_BUILDS_PER_PASS: '3',
      SANDBOX_DECLARED_BUILD_SECONDS: '90',
      SANDBOX_DECLARED_SETTLE_SECONDS: '0',
      SANDBOX_DECLARED_FOOTPRINT_CPU_MILLICORES: '250',
      SANDBOX_DECLARED_FOOTPRINT_MEMORY_MB: '256',
      SANDBOX_REAP_ATTEMPTS_BEFORE_HELP: '5',
    });

    expect(config.maxBuildsPerPass).toBe(3);
    expect(config.declaredBuildSeconds).toBe(90);
    expect(config.declaredSettleSeconds).toBe(0);
    expect(config.declaredFootprint).toEqual({
      cpuMillicores: 250,
      memoryMb: 256,
    });
    expect(config.reapAttemptsBeforeHelp).toBe(5);
  });

  it('has defaults for all of them', () => {
    const config = loadSandboxConfig({});

    expect(config.maxBuildsPerPass).toBe(8);
    expect(config.declaredBuildSeconds).toBe(126);
    expect(config.declaredSettleSeconds).toBe(76);
    expect(config.reapAttemptsBeforeHelp).toBe(3);
  });
});

describe('workloadDeadline', () => {
  const HOUR = 3_600_000;
  const cfg = loadSandboxConfig({});
  const born = new Date('2026-10-07T00:00:00Z');
  const at = (h: number) => new Date(born.getTime() + h * HOUR);

  it('is a day after the deploy when the guest never acted', () => {
    expect(workloadDeadline(born, null, cfg)).toEqual(at(24));
  });

  it('follows the last action by a day', () => {
    expect(workloadDeadline(born, at(30), cfg)).toEqual(at(54));
  });

  it('never moves earlier than the base because of an old action', () => {
    expect(workloadDeadline(born, at(-10), cfg)).toEqual(at(24));
  });

  it('never goes past the longest lifetime', () => {
    expect(workloadDeadline(born, at(70), cfg)).toEqual(at(72));
  });

  it('reads all three from the environment', () => {
    const custom = loadSandboxConfig({
      SANDBOX_WORKLOAD_TTL_HOURS: '2',
      SANDBOX_WORKLOAD_IDLE_HOURS: '1',
      SANDBOX_WORKLOAD_MAX_HOURS: '720',
    });
    expect(workloadDeadline(born, at(100), custom)).toEqual(at(101));
  });
});

describe('refused email domains', () => {
  it('keeps the built-in list unless told otherwise, and turns it off with none', () => {
    expect(refusedEmailDomains(undefined)).toContain('mailinator.com');
    expect(refusedEmailDomains('none')).toEqual([]);
    expect(refusedEmailDomains('@Spam.example, other.test')).toEqual([
      'spam.example',
      'other.test',
    ]);
  });

  it('matches the domain and anything below it, never a lookalike', () => {
    const domains = ['mailinator.com'];
    expect(isRefusedEmail('a@mailinator.com', domains)).toBe(true);
    expect(isRefusedEmail('a@eu.mailinator.com', domains)).toBe(true);
    expect(isRefusedEmail('a@notmailinator.com', domains)).toBe(false);
    expect(isRefusedEmail(null, domains)).toBe(false);
  });
});

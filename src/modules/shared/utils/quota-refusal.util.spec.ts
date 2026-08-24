import {
  QUOTA_EXCEEDED_CODE,
  describeQuotaRefusal,
  isQuotaRefusal,
} from './quota-refusal.util';

/**
 * Every string below is the shape Kubernetes actually produces. They are quoted
 * rather than constructed because the whole point of this file is that the
 * wording is not ours: a test that built the sentence itself would prove only
 * that the test and the parser agree.
 */
const K8S = {
  pods: 'pods "shop-7d9f8b-x2k4l" is forbidden: exceeded quota: sandbox-quota, requested: pods=1, used: pods=12, limited: pods=12',
  services:
    'services "shop-svc" is forbidden: exceeded quota: sandbox-quota, requested: services=1, used: services=12, limited: services=12',
  volumes:
    'persistentvolumeclaims "data-shop-0" is forbidden: exceeded quota: sandbox-quota, requested: persistentvolumeclaims=1,requests.storage=5Gi, used: persistentvolumeclaims=8,requests.storage=12Gi, limited: persistentvolumeclaims=8,requests.storage=12Gi',
  cpu: 'pods "shop-7d9f8b-x2k4l" is forbidden: exceeded quota: sandbox-quota, requested: requests.cpu=500m, used: requests.cpu=1300m, limited: requests.cpu=1500m',
  memory:
    'pods "shop-7d9f8b-x2k4l" is forbidden: exceeded quota: sandbox-quota, requested: requests.memory=512Mi, used: requests.memory=2Gi, limited: requests.memory=2Gi',
  limitRange:
    'pods "shop-7d9f8b-x2k4l" is forbidden: maximum cpu usage per Container is 1, but limit is 2',
  someoneElsesQuota:
    'pods "web-1" is forbidden: exceeded quota: team-quota, requested: pods=1, used: pods=40, limited: pods=40',
};

/** How @kubernetes/client-node hands the same status back to a caller. */
function asClientError(k8sMessage: string): Error {
  const body = JSON.stringify({
    kind: 'Status',
    apiVersion: 'v1',
    status: 'Failure',
    message: k8sMessage,
    reason: 'Forbidden',
    code: 403,
  });
  return new Error(
    `HTTP-Code: 403\nMessage: Forbidden\nBody: ${body}\nHeaders: {}`,
  );
}

/**
 * Captured off the running instance on 2026-08-24 with `kubectl apply
 * --dry-run=server` against a live sandbox tenancy (nothing was created, and the
 * dry run consumes no quota). They are here because a parser tested only against
 * strings its author invented proves nothing about the cluster.
 */
const LIVE = {
  containerCeiling:
    'Error from server (Forbidden): error when creating "STDIN": pods "flui-quota-probe-a" is forbidden: maximum cpu usage per Container is 1, but limit is 4',
  volumeCeiling:
    'Error from server (Forbidden): error when creating "STDIN": persistentvolumeclaims "flui-quota-probe-c" is forbidden: maximum storage usage per PersistentVolumeClaim is 12Gi, but request is 100Gi',
  storageQuota:
    'Error from server (Forbidden): error when creating "STDIN": persistentvolumeclaims "flui-quota-probe-e" is forbidden: exceeded quota: sandbox-quota, requested: requests.storage=11Gi, used: requests.storage=7Gi, limited: requests.storage=12Gi',
};

describe('reading the refusals a live sandbox tenancy actually produced', () => {
  it('reads the storage a tenancy has used, and of how much', () => {
    const refusal = describeQuotaRefusal(LIVE.storageQuota);
    expect(refusal).not.toBeNull();
    expect(refusal!.sandbox).toBe(true);
    expect(refusal!.message).toContain('7Gi of the 12Gi storage');
    expect(refusal!.message).toContain('your trial allows');
  });

  it('reads the per-container ceiling the LimitRange imposes', () => {
    const refusal = describeQuotaRefusal(LIVE.containerCeiling);
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('at most 1 cpu');
    expect(refusal!.message).toContain('asks for 4');
  });

  it('reads the per-volume ceiling, which is worded like the container one', () => {
    const refusal = describeQuotaRefusal(LIVE.volumeCeiling);
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('at most 12Gi storage');
    expect(refusal!.message).toContain('asks for 100Gi');
  });
});

describe('reading a Kubernetes quota refusal as a sentence', () => {
  it('says how many pods are used and of how many', () => {
    const refusal = describeQuotaRefusal(K8S.pods);
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('12 of the 12 pods');
    expect(refusal!.message).toContain('your trial allows');
  });

  it('carries a code the interface can branch on', () => {
    expect(describeQuotaRefusal(K8S.pods)!.code).toBe(QUOTA_EXCEEDED_CODE);
    // The dashboard tells a refusal from a fault by this prefix.
    expect(QUOTA_EXCEEDED_CODE.startsWith('SANDBOX_')).toBe(true);
  });

  it('reads the same refusal out of the client library’s wrapper', () => {
    const refusal = describeQuotaRefusal(asClientError(K8S.pods));
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('12 of the 12 pods');
  });

  it('names services, volumes, CPU, memory and storage by their own nouns', () => {
    expect(describeQuotaRefusal(K8S.services)!.message).toContain(
      '12 of the 12 services',
    );
    expect(describeQuotaRefusal(K8S.cpu)!.message).toContain(
      '1300m of the 1500m CPU (requested)',
    );
    expect(describeQuotaRefusal(K8S.memory)!.message).toContain(
      '2Gi of the 2Gi memory (requested)',
    );
  });

  it('names every resource at its ceiling when a request trips more than one', () => {
    const message = describeQuotaRefusal(K8S.volumes)!.message;
    expect(message).toContain('8 of the 8 volumes');
    expect(message).toContain('12Gi of the 12Gi storage');
  });

  it('reads a LimitRange refusal, which names no quota at all', () => {
    const refusal = describeQuotaRefusal(K8S.limitRange);
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('at most 1 cpu');
    expect(refusal!.message).toContain('asks for 2');
  });

  it('does not call somebody else’s quota a trial', () => {
    const refusal = describeQuotaRefusal(K8S.someoneElsesQuota);
    expect(refusal!.sandbox).toBe(false);
    expect(refusal!.message).toContain('this namespace allows');
    expect(refusal!.message).not.toContain('trial');
  });

  it('marks the sandbox quota as the sandbox quota', () => {
    expect(describeQuotaRefusal(K8S.pods)!.sandbox).toBe(true);
    expect(describeQuotaRefusal(K8S.pods)!.limitName).toBe('sandbox-quota');
  });

  it('refuses to dress a real failure up as a limit', () => {
    expect(describeQuotaRefusal(new Error('connect ECONNREFUSED'))).toBeNull();
    expect(
      describeQuotaRefusal(
        new Error(
          'Deployment.apps "shop" is invalid: spec.replicas: Invalid value',
        ),
      ),
    ).toBeNull();
    expect(
      describeQuotaRefusal(new Error('secrets "db" not found')),
    ).toBeNull();
    expect(describeQuotaRefusal(null)).toBeNull();
    expect(describeQuotaRefusal(undefined)).toBeNull();
    expect(describeQuotaRefusal({})).toBeNull();
    expect(isQuotaRefusal(new Error('boom'))).toBe(false);
  });

  it('reads a refusal handed over as a plain status object', () => {
    const refusal = describeQuotaRefusal({
      message: 'Forbidden',
      body: { message: K8S.pods },
    });
    expect(refusal).not.toBeNull();
    expect(refusal!.message).toContain('12 of the 12 pods');
  });
});

jest.mock('@kubernetes/client-node', () => ({}));

import { SandboxNoticeService } from './sandbox-notice.service';
import {
  buildNoticeDeployment,
  buildNoticeMiddleware,
} from '../constants/sandbox-notice.manifest';

const notice = { tryUrl: 'https://flui.cloud', abuseUrl: null, minutes: 60 };

function make(existingKey: boolean, areas: string[] = ['p-area-1']) {
  const applied: Array<Record<string, any>> = [];
  const k8s = {
    ensureNamespaceExists: jest.fn(),
    getResource: jest.fn(async () => (existingKey ? { body: {} } : null)),
    applyManifest: jest.fn(async (_kc: string, m: string) => {
      applied.push(JSON.parse(m));
    }),
  };
  const service = new SandboxNoticeService(
    k8s as never,
    { decrypt: () => 'kubeconfig' } as never,
    { findOne: async () => ({ kubeconfigEncrypted: 'x' }) } as never,
    { find: async () => areas.map((namespace) => ({ namespace })) } as never,
    { clusterId: 'c1', notice, allowMasterPlacement: false } as never,
  );
  return { service, applied };
}

describe('trial notice on the sandbox cluster', () => {
  it('makes the signing key once and keeps it afterwards', async () => {
    const first = make(false);
    await first.service.ensure();
    const secret = first.applied.find((m) => m.kind === 'Secret');
    expect(secret?.stringData.key.length).toBeGreaterThanOrEqual(32);

    const again = make(true);
    await again.service.ensure();
    expect(again.applied.some((m) => m.kind === 'Secret')).toBe(false);
  });

  it('runs the notice and puts every live area behind it', async () => {
    const { service, applied } = make(true, ['p-area-1', 'p-area-2']);
    await service.ensure();
    expect(applied.map((m) => `${m.kind}/${m.metadata.namespace}`)).toEqual([
      'Service/flui-system',
      'Deployment/flui-system',
      'Middleware/p-area-1',
      'Middleware/p-area-2',
    ]);
  });

  it('lets Traefik name the host, never the client', () => {
    const middleware = JSON.parse(buildNoticeMiddleware('p-area-1'));
    expect(middleware.spec.forwardAuth).toEqual({
      address:
        'http://flui-trial-notice.flui-system.svc.cluster.local/trial-notice',
      trustForwardHeader: false,
    });
  });

  it('reads the key from the cluster secret and leaves out an abuse link nobody set', () => {
    const deployment = JSON.parse(
      buildNoticeDeployment('img:1', notice, false),
    );
    const env = deployment.spec.template.spec.containers[0].env;
    expect(env.find((e: any) => e.name === 'NOTICE_KEY').valueFrom).toEqual({
      secretKeyRef: { name: 'flui-trial-notice-key', key: 'key' },
    });
    expect(env.some((e: any) => e.name === 'NOTICE_ABUSE_URL')).toBe(false);
    expect(deployment.spec.template.spec.tolerations).toBeUndefined();
  });

  it('may run on the master only where guests may', () => {
    const deployment = JSON.parse(buildNoticeDeployment('img:1', notice, true));
    expect(
      deployment.spec.template.spec.tolerations.map((t: any) => t.key),
    ).toEqual([
      'node-role.kubernetes.io/control-plane',
      'node-role.kubernetes.io/master',
    ]);
  });
});

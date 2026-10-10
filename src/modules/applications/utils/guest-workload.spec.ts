import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from '../services/application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationCategory } from '../enums/application-category.enum';
import {
  stripSandboxInstallPlacement,
  stripSandboxPlacementFields,
  stripSandboxUpdateFields,
} from './sandbox-placement.util';
import { withGuestRuntime } from './guest-runtime';

/** F-099 / F-100: what a guest may decide about its workload, and how it runs. */
describe('a guest workload', () => {
  it('leaves placement, companions, claims, node-wide kinds, the system category and platform labels to the platform', () => {
    const dto = {
      name: 'x',
      category: ApplicationCategory.SYSTEM,
      workloadKind: 'DaemonSet',
      companions: { sidecars: [{ name: 'spy', image: 'busybox' }] },
      metadata: { driftPolicy: 'auto_heal' },
      labels: {
        team: 'blue',
        app: 'flui-api',
        'flui-app-id': 'other',
        'flui.cloud/scope': 'system',
        'app.kubernetes.io/name': 'x',
      },
      volumes: [
        {
          name: 'data',
          mountPath: '/data',
          claimNameOverride: 'someone-elses',
          storageClass: 'flui-local',
        },
      ],
      dedicatedNodeName: 'master',
    } as never;
    stripSandboxPlacementFields(dto);
    expect(dto).toMatchObject({
      category: ApplicationCategory.USER,
      labels: { team: 'blue' },
    });
    expect(Object.keys((dto as { labels: object }).labels)).toEqual(['team']);
    for (const key of [
      'workloadKind',
      'companions',
      'metadata',
      'dedicatedNodeName',
    ]) {
      expect(dto).not.toHaveProperty(key);
    }
    expect((dto as { volumes: object[] }).volumes).toEqual([
      { name: 'data', mountPath: '/data' },
    ]);
  });

  it('cannot add them later with a change either', () => {
    const dto = {
      labels: { 'flui-app-id': 'x', ok: '1' },
      metadata: { a: 'b' },
      companions: {},
    } as never;
    stripSandboxUpdateFields(dto);
    expect(dto).toEqual({ labels: { ok: '1' } });
  });

  it('cannot skip the capacity gate on a catalog install', () => {
    const dto = { force: true, allowMasterPlacement: true, projectId: 'p' };
    stripSandboxInstallPlacement(dto);
    expect(dto).toEqual({});
  });

  describe('as rendered on the guests’ cluster', () => {
    const generator = new ApplicationManifestGeneratorService({
      encrypt: (v: string) => v,
      decrypt: (v: string) => v,
    } as unknown as EncryptionService);
    const app = {
      id: 'a',
      slug: 'web',
      name: 'web',
      k8sNamespace: 'guest-1',
      clusterId: 'guests',
      replicas: 1,
      sourceConfig: { imageRef: 'nginx:1' },
    };
    const podOf = (a: object) => {
      const workload = generator
        .generateForDockerImage(a as unknown as ApplicationEntity)
        .find((m) => m.kind === 'Deployment')!;
      return (
        load(workload.yaml) as {
          spec: { template: { spec: Record<string, any> } };
        }
      ).spec.template.spec;
    };

    it('runs with the default syscall filter, no escalation, no raw sockets and no token', () => {
      const pod = podOf(withGuestRuntime(app, 'guests'));
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.securityContext.seccompProfile).toEqual({
        type: 'RuntimeDefault',
      });
      expect(pod.securityContext.runAsNonRoot).toBeUndefined();
      expect(pod.containers[0].securityContext).toEqual({
        allowPrivilegeEscalation: false,
        capabilities: { drop: ['NET_RAW'] },
      });
    });

    it('changes nothing for a workload on any other cluster', () => {
      const pod = podOf(withGuestRuntime(app, 'some-other-cluster'));
      expect(pod.automountServiceAccountToken).toBeUndefined();
      expect(pod.containers[0].securityContext).toBeUndefined();
    });
  });
});

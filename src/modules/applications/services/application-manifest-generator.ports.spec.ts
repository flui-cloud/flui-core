import { load } from 'js-yaml';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationEntity } from '../entities/application.entity';
import { withGuestRuntime } from '../utils/guest-runtime';

describe('an application with public UDP ports', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);
  const app = {
    id: 'a',
    slug: 'jvb',
    name: 'jvb',
    k8sNamespace: 'calls',
    clusterId: 'c',
    replicas: 1,
    port: 9090,
    sourceConfig: { imageRef: 'jitsi/jvb:stable' },
    udpPorts: [{ name: 'media', port: 10000 }],
  };
  const deploymentOf = (a: object) => {
    const workload = generator
      .generateForDockerImage(a as unknown as ApplicationEntity)
      .find((m) => m.kind === 'Deployment')!;
    return load(workload.yaml) as {
      spec: {
        strategy?: { type: string };
        template: { spec: { containers: Array<{ ports?: object[] }> } };
      };
    };
  };
  const portsOf = (a: object) =>
    deploymentOf(a).spec.template.spec.containers[0].ports;

  it('publishes them on the node next to the main port', () => {
    expect(portsOf(app)).toEqual([
      { containerPort: 9090, protocol: 'TCP' },
      { name: 'media', containerPort: 10000, hostPort: 10000, protocol: 'UDP' },
    ]);
  });

  it('publishes them even without a main port', () => {
    expect(portsOf({ ...app, port: undefined })).toEqual([
      { name: 'media', containerPort: 10000, hostPort: 10000, protocol: 'UDP' },
    ]);
  });

  it('never publishes a port outside the application range', () => {
    expect(
      portsOf({ ...app, udpPorts: [{ name: 'overlay', port: 51871 }] }),
    ).toEqual([{ containerPort: 9090, protocol: 'TCP' }]);
  });

  it('replaces the pod instead of rolling, since the new one could not take the port', () => {
    expect(deploymentOf(app).spec.strategy).toEqual({ type: 'Recreate' });
    expect(
      deploymentOf({ ...app, udpPorts: null }).spec.strategy,
    ).toBeUndefined();
  });

  it('publishes nothing on the node for a guest', () => {
    expect(portsOf(withGuestRuntime(app, 'c'))).toEqual([
      { containerPort: 9090, protocol: 'TCP' },
    ]);
  });
});

describe('an application with internal ports beyond its main one', () => {
  const generator = new ApplicationManifestGeneratorService({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  } as unknown as EncryptionService);
  const app = {
    id: 'p',
    slug: 'xmpp',
    name: 'xmpp',
    k8sNamespace: 'calls',
    clusterId: 'c',
    replicas: 1,
    port: 5222,
    sourceConfig: { imageRef: 'jitsi/prosody:stable' },
  };
  const servicePorts = (a: object, name: string) => {
    const svc = generator
      .generateForDockerImage(a as unknown as ApplicationEntity)
      .find((m) => m.kind === 'Service' && m.name === name)!;
    return (load(svc.yaml) as { spec: { ports: object[] } }).spec.ports;
  };

  it('keeps the single unnamed port of an app with one', () => {
    expect(servicePorts(app, 'xmpp-svc')).toEqual([
      { port: 5222, targetPort: 5222, protocol: 'TCP' },
    ]);
  });

  it('serves the others on the same address, each named', () => {
    expect(
      servicePorts(
        { ...app, extraPorts: [{ name: 'http', port: 5280 }] },
        'xmpp-svc',
      ),
    ).toEqual([
      { name: 'main', port: 5222, targetPort: 5222, protocol: 'TCP' },
      { name: 'http', port: 5280, targetPort: 5280, protocol: 'TCP' },
    ]);
  });

  it('does the same on the headless address of a stateful app', () => {
    expect(
      servicePorts(
        {
          ...app,
          workloadKind: 'StatefulSet',
          volumes: [{ name: 'data', mountPath: '/config', size: '1Gi' }],
          extraPorts: [{ name: 'http', port: 5280 }],
        },
        'xmpp-headless',
      ),
    ).toEqual([
      { name: 'main', port: 5222, targetPort: 5222, protocol: 'TCP' },
      { name: 'http', port: 5280, targetPort: 5280, protocol: 'TCP' },
    ]);
  });

  it('never repeats the main port, and keeps names unique', () => {
    expect(
      servicePorts(
        {
          ...app,
          extraPorts: [
            { name: 'again', port: 5222 },
            { name: 'main', port: 5280 },
          ],
        },
        'xmpp-svc',
      ),
    ).toEqual([
      { name: 'primary', port: 5222, targetPort: 5222, protocol: 'TCP' },
      { name: 'main', port: 5280, targetPort: 5280, protocol: 'TCP' },
    ]);
  });
});

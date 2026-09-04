import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';

describe('ApplicationManifestGeneratorService sidecars', () => {
  const render = (app: any): string =>
    (
      ApplicationManifestGeneratorService.prototype as any
    ).renderSidecarsBlock.call({}, app);

  it('renders nothing when an application declares no sidecar', () => {
    // Every existing application takes this path, so it is the one that must
    // leave the manifest byte-identical to before.
    expect(render({ sidecars: [] })).toBe('');
    expect(render({})).toBe('');
  });

  it('renders a container with its command, mounts and bounded resources', () => {
    const yaml = render({
      sidecars: [
        {
          name: 'binlog-shipper',
          image: 'ghcr.io/flui-cloud/mariadb-shipper:11',
          command: ['/usr/local/bin/ship.sh'],
          mounts: [
            { name: 'data', mountPath: '/var/lib/mysql', readOnly: true },
          ],
        },
      ],
    });

    expect(yaml).toContain('- name: binlog-shipper');
    expect(yaml).toContain('- "/usr/local/bin/ship.sh"');
    expect(yaml).toContain('mountPath: /var/lib/mysql');
    expect(yaml).toContain('readOnly: true');
    // Defaults rather than nothing: an unbounded companion competes with the
    // database it is meant to protect.
    expect(yaml).toContain('cpu: "10m"');
    expect(yaml).toContain('memory: "256Mi"');
  });

  it('takes a secret by reference and never by value', () => {
    const yaml = render({
      sidecars: [
        {
          name: 'shipper',
          image: 'x',
          env: [
            { name: 'PLAIN', value: 'visible' },
            {
              name: 'S3_SECRET_KEY',
              secretRef: { name: 'flui-backup-s3', key: 'secretKey' },
            },
          ],
        },
      ],
    });

    // Object-storage credentials reach the sidecar and nothing else — the
    // application's own container never sees them, which is an improvement on
    // the pgBackRest layout where they sit in a file on the data volume.
    expect(yaml).toContain('secretKeyRef:');
    expect(yaml).toContain('name: flui-backup-s3');
    expect(yaml).not.toContain('value: "visible"\n              valueFrom');
    expect(yaml).toContain('value: "visible"');
  });

  it('quotes a command so an argument with spaces survives', () => {
    const yaml = render({
      sidecars: [
        { name: 's', image: 'x', command: ['sh', '-c', 'echo one two'] },
      ],
    });

    expect(yaml).toContain('- "echo one two"');
  });
});

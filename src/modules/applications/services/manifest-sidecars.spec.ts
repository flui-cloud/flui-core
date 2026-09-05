import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';

describe('ApplicationManifestGeneratorService sidecars', () => {
  const gen = ApplicationManifestGeneratorService.prototype as any;
  const self = {
    companionsOf: gen.companionsOf,
    renderCompanionContainers: gen.renderCompanionContainers,
    renderCompanionVolumeLines: gen.renderCompanionVolumeLines,
    fillSlug: gen.fillSlug,
  };
  const render = (companions: any, slug = 'app'): string =>
    gen.renderSidecarsBlock.call(self, { slug, companions });
  const renderInit = (companions: any, slug = 'app'): string =>
    gen.renderInitContainersBlock.call(self, { slug, companions });
  const renderVolumes = (companions: any, slug = 'app'): string =>
    gen.renderCompanionVolumeLines.call(self, { slug, companions }).join('\n');

  it('renders nothing when an application declares no sidecar', () => {
    // Every existing application takes this path, so it is the one that must
    // leave the manifest byte-identical to before.
    expect(render({ sidecars: [] })).toBe('');
    expect(render({})).toBe('');
    expect(render(undefined)).toBe('');
    expect(renderInit({})).toBe('');
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

describe('ApplicationManifestGeneratorService companions', () => {
  const gen = ApplicationManifestGeneratorService.prototype as any;
  const self = {
    companionsOf: gen.companionsOf,
    renderCompanionContainers: gen.renderCompanionContainers,
    renderCompanionVolumeLines: gen.renderCompanionVolumeLines,
    fillSlug: gen.fillSlug,
  };
  const renderInit = (companions: any, slug = 'app'): string =>
    gen.renderInitContainersBlock.call(self, { slug, companions });
  const renderVolumes = (companions: any, slug = 'app'): string =>
    gen.renderCompanionVolumeLines.call(self, { slug, companions }).join('\n');

  it('puts init containers under their own key, before the application', () => {
    // A restore has to have written the data directory before the server's
    // entrypoint looks at it: seeing an empty one, that entrypoint initialises
    // a fresh database, and the restore then refuses a directory that is no
    // longer empty.
    const yaml = renderInit({
      initContainers: [
        { name: 'flui-restore', image: 'shipper:11', inheritAppEnv: true },
      ],
    });

    expect(yaml).toContain('      initContainers:');
    expect(yaml).toContain('- name: flui-restore');
  });

  it('gives a companion the application’s own environment by reference', () => {
    // Both marked optional: an application with only plain variables has no
    // Secret and one with only secret variables has no ConfigMap, and a
    // missing object must not keep the pod from starting.
    const yaml = renderInit(
      { initContainers: [{ name: 'x', image: 'i', inheritAppEnv: true }] },
      'mariadb-abc',
    );

    expect(yaml).toContain('envFrom:');
    expect(yaml).toContain('name: mariadb-abc-config');
    expect(yaml).toContain('name: mariadb-abc-secret');
    expect(yaml.match(/optional: true/g)).toHaveLength(2);
  });

  it('mounts a Secret that does not exist yet without blocking the pod', () => {
    // This is what lets a backup policy be turned on without restarting the
    // database it protects: the pod starts with the volume empty, and kubelet
    // fills it in when the Secret appears.
    const yaml = renderVolumes({
      volumes: [
        {
          name: 'shipper-config',
          secret: { secretName: 'app-binlog-shipper' },
        },
      ],
    });

    expect(yaml).toContain('secretName: app-binlog-shipper');
    expect(yaml).toContain('optional: true');
  });

  it('renders an emptyDir with its ceiling', () => {
    const yaml = renderVolumes({
      volumes: [{ name: 'spool', emptyDir: { sizeLimit: '2Gi' } }],
    });

    expect(yaml).toContain('emptyDir:');
    expect(yaml).toContain('sizeLimit: 2Gi');
  });
});

describe('ApplicationManifestGeneratorService companion slug token', () => {
  const gen = ApplicationManifestGeneratorService.prototype as any;
  const self = {
    companionsOf: gen.companionsOf,
    renderCompanionContainers: gen.renderCompanionContainers,
    renderCompanionVolumeLines: gen.renderCompanionVolumeLines,
    fillSlug: gen.fillSlug,
  };

  it('names the companion’s objects after the APPLICATION, not the install', () => {
    // An install's slug and the slug of the application it mints are different
    // strings — a catalog install can mint one application per component — and
    // the Secret a companion waits for is written by the engine against the
    // application's slug. Resolving the token any earlier produced a name the
    // writer would never use, and a shipper that waited forever for a file
    // being written next door.
    const yaml = gen.renderCompanionVolumeLines
      .call(self, {
        slug: 'mariadb-307f9b-v73l1x',
        companions: {
          volumes: [
            {
              name: 'flui-shipper-config',
              secret: { secretName: '{{app.slug}}-binlog-shipper' },
            },
          ],
        },
      })
      .join('\n');

    expect(yaml).toContain('secretName: mariadb-307f9b-v73l1x-binlog-shipper');
    expect(yaml).not.toContain('{{app.slug}}');
  });
});

import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import {
  PGBACKREST_PLUGIN_IMAGE_DIGESTS,
  archiveThroughPluginPatch,
  pinnedPgbackrestPluginManifest,
  pluginBackupState,
  promotedReplicaPatch,
  renderPgbackrestStanza,
  renderPluginBackup,
  stopArchivingPatch,
} from './pgbackrest-plugin.core';

const sidecar = 'registry.hub.docker.com/dalibo/cnpg-pgbackrest-sidecar:0.0.3';
const controller =
  'registry.hub.docker.com/dalibo/cnpg-pgbackrest-controller:0.0.3';

describe('the pgBackRest plugin, pinned', () => {
  const manifest = [
    yaml.dump({
      apiVersion: 'v1',
      kind: 'Secret',
      data: { SIDECAR_IMAGE: Buffer.from(`${sidecar}\n`).toString('base64') },
    }),
    yaml.dump({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      spec: { template: { spec: { containers: [{ image: controller }] } } },
    }),
  ].join('---\n');
  const sha = createHash('sha256').update(manifest).digest('hex');

  it('refuses a manifest that is not the one checked', () => {
    expect(() => pinnedPgbackrestPluginManifest(manifest)).toThrow(
      'is not the one Flui checked',
    );
  });

  it('fixes the controller and the sidecar it hands to every instance', () => {
    const [secret, deployment] = yaml.loadAll(
      pinnedPgbackrestPluginManifest(manifest, sha),
    ) as any[];
    expect(Buffer.from(secret.data.SIDECAR_IMAGE, 'base64').toString()).toBe(
      `${sidecar}@${PGBACKREST_PLUGIN_IMAGE_DIGESTS[sidecar]}`,
    );
    expect(deployment.spec.template.spec.containers[0].image).toBe(
      `${controller}@${PGBACKREST_PLUGIN_IMAGE_DIGESTS[controller]}`,
    );
  });
});

describe('the repository of a highly available database', () => {
  const stanza = renderPgbackrestStanza({
    cluster: 'orders-db-ha',
    namespace: 'ns',
    stanza: 'main',
    repository: {
      bucket: 'flui-backups',
      endpoint: 'fsn1.your-objectstorage.com',
      region: 'fsn1',
      repoPath: '/eu/pgbackrest/a1/ha-20261108/',
      pathStyle: false,
      retentionFull: 2,
    },
  }) as any;
  const repo = stanza.spec.stanzaConfiguration.s3Repositories[0];

  it('is encrypted with the destination passphrase, from a Secret beside it', () => {
    expect(repo.cipherConfig).toEqual({
      type: 'aes-256-cbc',
      encryptionPass: {
        name: 'orders-db-ha-pgbackrest',
        key: 'ENCRYPTION_PASS',
      },
    });
    expect(repo.secretRef.accessKeyId.name).toBe('orders-db-ha-pgbackrest');
  });

  it('keeps stanza, compression and bundling of the single instance, and verifies TLS', () => {
    expect(stanza.spec.stanzaConfiguration).toMatchObject({
      name: 'main',
      compressConfig: { type: 'zst', level: 3 },
      customEnvVar: {
        PGBACKREST_REPO1_BUNDLE: 'y',
        PGBACKREST_REPO1_BLOCK: 'y',
      },
    });
    expect(repo).toMatchObject({ uriStyle: 'host', verifyTLS: true });
    expect(repo.retentionPolicy).toEqual({
      full: 2,
      fullType: 'count',
      archiveType: 'full',
    });
  });

  it('archives through the plugin, and stops by removing it', () => {
    const on = archiveThroughPluginPatch({
      cluster: 'orders-db-ha',
      namespace: 'ns',
    }) as any;
    expect(on.spec.plugins).toEqual([
      {
        name: 'pgbackrest.dalibo.com',
        enabled: true,
        isWALArchiver: true,
        parameters: { stanzaRef: 'orders-db-ha-pgbackrest' },
      },
    ]);
    expect(
      (stopArchivingPatch({ cluster: 'orders-db-ha', namespace: 'ns' }) as any)
        .spec,
    ).toEqual({
      plugins: null,
    });
  });

  it('drops the replica section a promoted copy keeps, which the plugin cannot read', () => {
    expect(
      (
        promotedReplicaPatch({
          cluster: 'orders-db-ha',
          namespace: 'ns',
        }) as any
      ).spec,
    ).toEqual({ replica: null });
  });

  it('takes a base on the primary and reads its label back', () => {
    const backup = renderPluginBackup({
      name: 'b1',
      cluster: 'orders-db-ha',
      namespace: 'ns',
      type: 'incr',
    }) as any;
    expect(backup.spec).toMatchObject({
      method: 'plugin',
      target: 'primary',
      pluginConfiguration: { parameters: { backupType: 'incr' } },
    });
    expect(
      pluginBackupState({
        status: { phase: 'completed', backupId: '20261108-101010F' },
      }),
    ).toEqual({
      phase: 'completed',
      label: '20261108-101010F',
    });
    expect(
      pluginBackupState({ status: { phase: 'failed', error: 'no space' } }),
    ).toEqual({
      phase: 'failed',
      error: 'no space',
    });
    expect(pluginBackupState({})).toEqual({ phase: 'running' });
  });
});

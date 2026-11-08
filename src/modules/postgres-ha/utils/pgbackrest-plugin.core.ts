import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { CNPG_API_VERSION } from '../postgres-ha.constants';

/**
 * Dalibo's pgBackRest plugin for CloudNativePG: the same tool, repository
 * format and client-side cipher Flui's single Postgres backs up with, so a
 * highly available database keeps the promise that the bucket alone does not
 * read its data. The manifest is the one of commit 1b88275: v0.0.3 with the
 * controller image of the same release.
 */
export const PGBACKREST_PLUGIN_NAME = 'pgbackrest.dalibo.com';
export const PGBACKREST_PLUGIN_API_VERSION = 'pgbackrest.dalibo.com/v1';
export const PGBACKREST_PLUGIN_MANIFEST_URL =
  'https://raw.githubusercontent.com/dalibo/cnpg-plugin-pgbackrest/1b88275d3684f1b5f3e59d2bbc560044fe44efa6/manifest.yaml';
export const PGBACKREST_PLUGIN_MANIFEST_SHA256 =
  'c36ab57a8e80814301c57d8696bdebfaaa99b2d3526e49d97934d34cd86e5dfe';
export const PGBACKREST_PLUGIN_DEPLOYMENT = 'pgbackrest-controller';
/** The container the plugin adds to every instance; pgBackRest reads its configuration from its env. */
export const PGBACKREST_SIDECAR = 'plugin-pgbackrest';

/** By the digest Docker Hub served on 8 November 2026; a tag can be moved, a digest cannot. */
export const PGBACKREST_PLUGIN_IMAGE_DIGESTS: Record<string, string> = {
  'registry.hub.docker.com/dalibo/cnpg-pgbackrest-controller:0.0.3':
    'sha256:9563249502db7c1ae22c5e1979ab7ffd040559ea8c7544bfad25c5254c7ceb2e',
  'registry.hub.docker.com/dalibo/cnpg-pgbackrest-sidecar:0.0.3':
    'sha256:3cb4ab8de262147f800be40e0bb082d33728060665282f1524d95c9772ee77c3',
  'registry.hub.docker.com/dalibo/cnpg-pgbackrest-sidecar-exporter:0.0.3':
    'sha256:45cbe4898b1b16a3cab0263a1af26c4af2cfbf523de5312836ad4b3adc98fcf0',
};

function pinned(image: string): string {
  if (image.includes('@')) return image;
  const digest = PGBACKREST_PLUGIN_IMAGE_DIGESTS[image];
  if (!digest) throw new Error(`No pinned digest for ${image}`);
  return `${image}@${digest}`;
}

function pinSidecarImages(secret: Record<string, any>): void {
  for (const key of ['SIDECAR_IMAGE', 'SIDECAR_EXPORTER_IMAGE']) {
    const value = secret.data?.[key];
    if (!value) continue;
    const image = Buffer.from(value, 'base64').toString().trim();
    secret.data[key] = Buffer.from(pinned(image)).toString('base64');
  }
}

function pinContainers(deployment: Record<string, any>): void {
  for (const c of deployment.spec?.template?.spec?.containers ?? []) {
    if (c.image) c.image = pinned(c.image);
  }
}

/**
 * The plugin's manifest with its controller and the images it hands to every
 * instance fixed by digest, after checking it is the manifest they were read
 * for. The sidecar images reach the controller through a Secret.
 */
export function pinnedPgbackrestPluginManifest(
  manifest: string,
  expectedSha256 = PGBACKREST_PLUGIN_MANIFEST_SHA256,
): string {
  const sha = createHash('sha256').update(manifest).digest('hex');
  if (sha !== expectedSha256) {
    throw new Error(
      `The pgBackRest plugin manifest is not the one Flui checked (SHA-256 ${sha}): refusing to install it`,
    );
  }
  const docs = yaml.loadAll(manifest).filter(Boolean) as Array<
    Record<string, any>
  >;
  for (const doc of docs) {
    if (doc.kind === 'Secret') pinSidecarImages(doc);
    if (doc.kind === 'Deployment') pinContainers(doc);
  }
  return docs.map((d) => yaml.dump(d, { lineWidth: -1 })).join('---\n');
}

export interface PluginRepository {
  bucket: string;
  /** Host, and port when there is one, without the scheme. */
  endpoint: string;
  region: string;
  /** `repo1-path`: the destination's prefix and the repository's own. */
  repoPath: string;
  pathStyle: boolean;
  retentionFull: number;
}

const KEY_ID = 'ACCESS_KEY_ID';
const KEY_SECRET = 'ACCESS_SECRET_KEY';
const CIPHER_PASS = 'ENCRYPTION_PASS';

/** One name for the Stanza and its Secret, beside the cluster they serve. */
export function pgbackrestStanzaName(cluster: string): string {
  return `${cluster}-pgbackrest`;
}

export function renderPgbackrestSecret(input: {
  cluster: string;
  namespace: string;
  accessKey: string;
  secretKey: string;
  cipherPass: string;
}): Record<string, unknown> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: pgbackrestStanzaName(input.cluster),
      namespace: input.namespace,
      labels: { 'flui.cloud/managed-by': 'flui-cloud' },
    },
    type: 'Opaque',
    stringData: {
      [KEY_ID]: input.accessKey,
      [KEY_SECRET]: input.secretKey,
      [CIPHER_PASS]: input.cipherPass,
    },
  };
}

/**
 * The repository the highly available cluster ships to: stanza `main`,
 * encrypted with the destination's passphrase, compressed and bundled the way
 * Flui's single Postgres does, so a restore reads it with the same code.
 */
export function renderPgbackrestStanza(input: {
  cluster: string;
  namespace: string;
  stanza: string;
  repository: PluginRepository;
}): Record<string, unknown> {
  const secret = pgbackrestStanzaName(input.cluster);
  const r = input.repository;
  return {
    apiVersion: PGBACKREST_PLUGIN_API_VERSION,
    kind: 'Stanza',
    metadata: {
      name: pgbackrestStanzaName(input.cluster),
      namespace: input.namespace,
      labels: { 'flui.cloud/managed-by': 'flui-cloud' },
    },
    spec: {
      stanzaConfiguration: {
        name: input.stanza,
        processMax: 4,
        startFast: true,
        compressConfig: { type: 'zst', level: 3 },
        customEnvVar: {
          PGBACKREST_REPO1_BUNDLE: 'y',
          PGBACKREST_REPO1_BLOCK: 'y',
        },
        s3Repositories: [
          {
            bucket: r.bucket,
            endpoint: r.endpoint,
            region: r.region,
            repoPath: r.repoPath,
            uriStyle: r.pathStyle ? 'path' : 'host',
            verifyTLS: true,
            retentionPolicy: {
              full: r.retentionFull,
              fullType: 'count',
              archiveType: 'full',
            },
            secretRef: {
              accessKeyId: { name: secret, key: KEY_ID },
              secretAccessKey: { name: secret, key: KEY_SECRET },
            },
            cipherConfig: {
              type: 'aes-256-cbc',
              encryptionPass: { name: secret, key: CIPHER_PASS },
            },
          },
        ],
      },
    },
  };
}

/** Patch that has the cluster's instances archive their log through the plugin. */
export function archiveThroughPluginPatch(input: {
  cluster: string;
  namespace: string;
}): Record<string, unknown> {
  return {
    apiVersion: CNPG_API_VERSION,
    kind: 'Cluster',
    metadata: { name: input.cluster, namespace: input.namespace },
    spec: {
      plugins: [
        {
          name: PGBACKREST_PLUGIN_NAME,
          enabled: true,
          isWALArchiver: true,
          parameters: { stanzaRef: pgbackrestStanzaName(input.cluster) },
        },
      ],
    },
  };
}

/** Patch that stops the archiving: a JSON merge patch removes the list. */
export function stopArchivingPatch(input: {
  cluster: string;
  namespace: string;
}): Record<string, unknown> {
  return {
    apiVersion: CNPG_API_VERSION,
    kind: 'Cluster',
    metadata: { name: input.cluster, namespace: input.namespace },
    spec: { plugins: null },
  };
}

/** A base backup taken on the primary, the only instance a pgBackRest backup can start from without a standby setup. */
export function renderPluginBackup(input: {
  name: string;
  cluster: string;
  namespace: string;
  type: 'full' | 'incr' | 'diff';
}): Record<string, unknown> {
  return {
    apiVersion: CNPG_API_VERSION,
    kind: 'Backup',
    metadata: {
      name: input.name,
      namespace: input.namespace,
      labels: { 'flui.cloud/managed-by': 'flui-cloud' },
    },
    spec: {
      cluster: { name: input.cluster },
      method: 'plugin',
      target: 'primary',
      pluginConfiguration: {
        name: PGBACKREST_PLUGIN_NAME,
        parameters: { backupType: input.type },
      },
    },
  };
}

export type PluginBackupState =
  | { phase: 'running' }
  | { phase: 'completed'; label: string }
  | { phase: 'failed'; error: string };

/** A `Backup`'s status: CloudNativePG records the label the plugin returned as its backup id. */
export function pluginBackupState(backup: {
  status?: {
    phase?: string;
    backupId?: string;
    backupName?: string;
    error?: string;
  };
}): PluginBackupState {
  const s = backup.status ?? {};
  if (s.phase === 'completed') {
    const label = s.backupId || s.backupName;
    return label
      ? { phase: 'completed', label }
      : { phase: 'failed', error: 'The backup completed without a label' };
  }
  if (s.phase === 'failed') {
    return { phase: 'failed', error: s.error || 'The backup failed' };
  }
  return { phase: 'running' };
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  FLUI_REGISTRY_CONFIG,
  FluiRegistryConfig,
  registryRepositoryFor,
} from '../flui-registry.config';
import { RegistryAction } from '../registry-scope';
import { RegistrySigningKeyService } from './registry-signing-key.service';

const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface FluiRegistryVersion {
  /** Stable number from the digest, the shape the image routes address versions by. */
  versionId: number;
  digest: string;
  tags: string[];
}

/** A digest's stable numeric handle: its first 12 hex digits, a safe integer. */
export function versionIdOf(digest: string): number {
  return Number.parseInt(digest.replace(/^sha256:/, '').slice(0, 12), 16);
}

/**
 * The API's own calls to the instance registry, one application's repository
 * at a time, with a token it signs for exactly that repository.
 */
@Injectable()
export class FluiRegistryClientService {
  private readonly logger = new Logger(FluiRegistryClientService.name);

  constructor(
    @Inject(FLUI_REGISTRY_CONFIG) private readonly config: FluiRegistryConfig,
    private readonly keys: RegistrySigningKeyService,
  ) {}

  async listVersions(applicationId: string): Promise<FluiRegistryVersion[]> {
    const repository = registryRepositoryFor(applicationId);
    const headers = await this.headers(repository, ['pull']);
    const listed = await fetch(`${this.baseUrl()}/v2/${repository}/tags/list`, {
      headers,
    });
    if (listed.status === 404) return [];
    if (!listed.ok) {
      throw new Error(`Registry tag list failed: HTTP ${listed.status}`);
    }
    const { tags } = (await listed.json()) as { tags?: string[] | null };
    const byDigest = new Map<string, string[]>();
    for (const tag of tags ?? []) {
      const digest = await this.digestOf(repository, tag, headers);
      if (!digest) continue;
      byDigest.set(digest, [...(byDigest.get(digest) ?? []), tag]);
    }
    return [...byDigest.entries()].map(([digest, grouped]) => ({
      versionId: versionIdOf(digest),
      digest,
      tags: grouped,
    }));
  }

  async deleteDigest(applicationId: string, digest: string): Promise<void> {
    const repository = registryRepositoryFor(applicationId);
    const response = await fetch(
      `${this.baseUrl()}/v2/${repository}/manifests/${digest}`,
      {
        method: 'DELETE',
        headers: await this.headers(repository, ['pull', 'delete']),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Registry delete failed: HTTP ${response.status}`);
    }
  }

  /**
   * Bytes the application's images take, each layer counted once however many
   * tags or platforms share it. Read from the manifests, so it needs nothing
   * of the registry beyond the distribution API.
   */
  async repositorySizeBytes(applicationId: string): Promise<number> {
    let total = 0;
    for (const size of (await this.repositoryBlobs(applicationId)).values()) {
      total += size;
    }
    return total;
  }

  /** The blobs the application's images are made of, by digest, with their size. */
  async repositoryBlobs(applicationId: string): Promise<Map<string, number>> {
    const repository = registryRepositoryFor(applicationId);
    const headers = await this.headers(repository, ['pull']);
    const visited = new Set<string>();
    const blobs = new Map<string, number>();
    const visit = async (reference: string): Promise<void> => {
      const response = await fetch(
        `${this.baseUrl()}/v2/${repository}/manifests/${reference}`,
        { headers: { ...headers, Accept: MANIFEST_TYPES } },
      );
      if (!response.ok) return;
      const manifest = (await response.json()) as {
        manifests?: Array<{ digest: string }>;
        config?: { digest: string; size: number };
        layers?: Array<{ digest: string; size: number }>;
      };
      for (const child of manifest.manifests ?? []) {
        if (!visited.has(child.digest)) {
          visited.add(child.digest);
          await visit(child.digest);
        }
      }
      for (const blob of [manifest.config, ...(manifest.layers ?? [])]) {
        if (blob) blobs.set(blob.digest, blob.size);
      }
    };
    for (const version of await this.listVersions(applicationId)) {
      await visit(version.digest);
    }
    return blobs;
  }

  /** Every image of the application; the registry's collection frees the space. */
  async deleteRepository(applicationId: string): Promise<number> {
    const versions = await this.listVersions(applicationId);
    for (const version of versions) {
      await this.deleteDigest(applicationId, version.digest);
    }
    return versions.length;
  }

  private async digestOf(
    repository: string,
    tag: string,
    headers: Record<string, string>,
  ): Promise<string | null> {
    const response = await fetch(
      `${this.baseUrl()}/v2/${repository}/manifests/${encodeURIComponent(tag)}`,
      { method: 'HEAD', headers: { ...headers, Accept: MANIFEST_TYPES } },
    );
    if (!response.ok) {
      this.logger.warn(
        `Registry HEAD ${repository}:${tag} → ${response.status}`,
      );
      return null;
    }
    return response.headers.get('docker-content-digest');
  }

  private async headers(
    repository: string,
    actions: Array<RegistryAction | 'delete'>,
  ): Promise<Record<string, string>> {
    const now = Math.floor(Date.now() / 1000);
    const token = await this.keys.sign({
      iss: this.config.issuer,
      sub: 'flui-api',
      aud: this.config.service,
      iat: now,
      nbf: now,
      exp: now + 60,
      jti: randomUUID(),
      access: [{ type: 'repository', name: repository, actions }],
    });
    return { Authorization: `Bearer ${token}` };
  }

  private baseUrl(): string {
    if (this.config.internalUrl) return this.config.internalUrl;
    if (!this.config.host) {
      throw new Error('The instance registry has no host configured');
    }
    return `https://${this.config.host}`;
  }
}

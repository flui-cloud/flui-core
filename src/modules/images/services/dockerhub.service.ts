import { Injectable, Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { getProjectPath } from '../../../common/utils/project-root.util';

export type DeployHint =
  | 'deployable'
  | 'needs-sidecar'
  | 'cli-tool'
  | 'build-image'
  | 'base-os';

interface HintPattern {
  match: string;
  matchType?: 'contains' | 'starts-with' | 'ends-with' | 'exact';
  hint: string;
  reason: string;
}

interface HintPatterns {
  tagPatterns: HintPattern[];
  imagePatterns: HintPattern[];
}

export interface DockerHubSearchResult {
  name: string;
  description: string;
  pullCount: number;
  starCount: number;
  isOfficial: boolean;
  isAutomated: boolean;
}

export interface DockerHubTag {
  name: string;
  digest: string;
  size: number;
  lastUpdated: string;
  architecture: string;
  /** true if the image has a linux/amd64 variant (compatible with x86_64 nodes) */
  compatible: boolean;
  /** all platform variants available for this tag, e.g. ['linux/amd64', 'linux/arm64/v8'] */
  platforms: string[];
  /** deployment suitability hint — informational only, user can override */
  deployHint: DeployHint;
  /** human-readable explanation for the hint, null when deployable */
  deployHintReason: string | null;
}

export interface DockerHubTagsResult {
  tags: DockerHubTag[];
  count: number;
  nextPage: number | null;
}

export interface ImageVerifyResult {
  exists: boolean;
  digest: string | null;
  size: number | null;
  lastUpdated: string | null;
}

const DOCKERHUB_API = 'https://hub.docker.com/v2';

@Injectable()
export class DockerHubService {
  private readonly logger = new Logger(DockerHubService.name);
  private hintPatterns: HintPatterns | null = null;

  /**
   * Search public images on DockerHub
   */
  async searchImages(
    query: string,
    limit = 10,
  ): Promise<DockerHubSearchResult[]> {
    const url = `${DOCKERHUB_API}/search/repositories/?query=${encodeURIComponent(query)}&page_size=${limit}`;

    this.logger.debug(`DockerHub search: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      this.logger.warn(`DockerHub search failed: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();

    return (data.results || []).map(
      (r: {
        repo_name: string;
        short_description?: string;
        pull_count?: number;
        star_count?: number;
        is_official?: boolean;
        is_automated?: boolean;
      }) => ({
        name: r.repo_name,
        description: r.short_description || '',
        pullCount: r.pull_count || 0,
        starCount: r.star_count || 0,
        isOfficial: r.is_official || false,
        isAutomated: r.is_automated || false,
      }),
    );
  }

  /**
   * List tags for an image on DockerHub — returns only linux/amd64 compatible tags.
   *
   * Fetches 2x the requested limit from DockerHub to compensate for filtering,
   * then filters to linux/amd64 and trims to the requested limit.
   */
  async listTags(
    image: string,
    page = 1,
    limit = 25,
  ): Promise<DockerHubTagsResult> {
    const namespace = this.resolveNamespace(image);
    // Fetch 2x to compensate for architecture filtering, capped at DockerHub max (100)
    const fetchSize = Math.min(limit * 2, 100);
    const url = `${DOCKERHUB_API}/repositories/${namespace}/tags/?page=${page}&page_size=${fetchSize}`;

    this.logger.debug(`DockerHub tags: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        return { tags: [], count: 0, nextPage: null };
      }
      this.logger.warn(`DockerHub tags failed: HTTP ${response.status}`);
      return { tags: [], count: 0, nextPage: null };
    }

    const data = await response.json();

    type DockerHubImage = {
      architecture: string;
      os: string;
      variant?: string;
      digest?: string;
      size?: number;
    };
    type DockerHubTagResult = {
      name: string;
      images?: DockerHubImage[];
      digest?: string;
      last_updated?: string;
      full_size?: number;
    };
    const allTags: DockerHubTag[] = (data.results || []).map(
      (t: DockerHubTagResult) => {
        const images: DockerHubImage[] = t.images || [];
        const amd64Image = images.find(
          (img) => img.architecture === 'amd64' && img.os === 'linux',
        );
        const compatible = !!amd64Image;
        // Attestation manifests are listed as `unknown/unknown`: not platforms.
        const platforms = images
          .filter(
            (img) => img.os !== 'unknown' && img.architecture !== 'unknown',
          )
          .map((img) => {
            const variant = img.variant ? `/${img.variant}` : '';
            return `${img.os}/${img.architecture}${variant}`;
          });

        const { hint, reason } = this.resolveDeployHint(image, t.name);

        return {
          name: t.name,
          digest: amd64Image?.digest || t.digest || '',
          size: amd64Image?.size || t.full_size || 0,
          lastUpdated: t.last_updated || '',
          architecture: amd64Image
            ? 'amd64'
            : images[0]?.architecture || 'unknown',
          compatible,
          platforms,
          deployHint: hint,
          deployHintReason: reason,
        };
      },
    );

    // Filter to linux/amd64 compatible only
    const compatibleTags = allTags.filter((t) => t.compatible);

    return {
      tags: compatibleTags.slice(0, limit),
      count: data.count || 0,
      nextPage: data.next ? page + 1 : null,
    };
  }

  /**
   * Verify if a specific image:tag exists on DockerHub
   */
  async verifyImage(imageRef: string): Promise<ImageVerifyResult> {
    const { image, tag } = this.parseImageRef(imageRef);
    const namespace = this.resolveNamespace(image);
    const url = `${DOCKERHUB_API}/repositories/${namespace}/tags/${encodeURIComponent(tag)}`;

    this.logger.debug(`DockerHub verify: ${url}`);

    try {
      const response = await fetch(url);

      if (response.status === 404) {
        return { exists: false, digest: null, size: null, lastUpdated: null };
      }

      if (!response.ok) {
        this.logger.warn(`DockerHub verify failed: HTTP ${response.status}`);
        return { exists: false, digest: null, size: null, lastUpdated: null };
      }

      const data = await response.json();

      return {
        exists: true,
        digest: data.digest || null,
        size: data.full_size || null,
        lastUpdated: data.last_updated || null,
      };
    } catch (error) {
      this.logger.error(`DockerHub verify error: ${error.message}`);
      return { exists: false, digest: null, size: null, lastUpdated: null };
    }
  }

  // ─── Deploy hint resolution ──────────────────────────────────────────────────

  private resolveDeployHint(
    imageName: string,
    tagName: string,
  ): { hint: DeployHint; reason: string | null } {
    const patterns = this.getHintPatterns();
    const tag = tagName.toLowerCase();
    // Strip namespace prefix (library/nginx → nginx, myuser/myimage → myimage)
    const image =
      imageName.split('/').pop()?.toLowerCase() ?? imageName.toLowerCase();

    // Tag patterns take priority — first match wins
    for (const p of patterns.tagPatterns) {
      if (this.matchesPattern(tag, p.match, p.matchType ?? 'contains')) {
        return { hint: p.hint as DeployHint, reason: p.reason };
      }
    }

    // Image patterns — exact match on repository name
    for (const p of patterns.imagePatterns) {
      if (image === p.match.toLowerCase()) {
        return { hint: p.hint as DeployHint, reason: p.reason };
      }
    }

    return { hint: 'deployable', reason: null };
  }

  private matchesPattern(
    value: string,
    pattern: string,
    matchType: string,
  ): boolean {
    const p = pattern.toLowerCase();
    switch (matchType) {
      case 'starts-with':
        return value.startsWith(p);
      case 'ends-with':
        return value.endsWith(p);
      case 'exact':
        return value === p;
      case 'contains':
      default:
        return value.includes(p);
    }
  }

  /** Lazy-load and cache hint patterns from JSON config file */
  private getHintPatterns(): HintPatterns {
    if (!this.hintPatterns) {
      try {
        const filePath = getProjectPath(
          'src',
          'modules',
          'images',
          'config',
          'deploy-hint-patterns.json',
        );
        this.hintPatterns = JSON.parse(
          readFileSync(filePath, 'utf-8'),
        ) as HintPatterns;
        this.logger.log(
          `Loaded deploy hint patterns: ${this.hintPatterns.tagPatterns.length} tag patterns, ` +
            `${this.hintPatterns.imagePatterns.length} image patterns`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to load deploy hint patterns: ${error.message}`,
        );
        this.hintPatterns = { tagPatterns: [], imagePatterns: [] };
      }
    }
    return this.hintPatterns;
  }

  /**
   * Inspect a Docker image via Registry API v2 and return the list of exposed ports.
   * Does NOT pull the image — only fetches the manifest + config blob (3 HTTP calls).
   * Returns [] on any error (private image, unreachable registry, no EXPOSE directive).
   */
  async inspectImagePorts(imageRef: string): Promise<number[]> {
    const { image, tag } = this.parseImageRef(imageRef);
    const namespace = this.resolveNamespace(image);

    try {
      // 1. Fetch anonymous pull token
      const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${namespace}:pull`;
      const tokenRes = await fetch(tokenUrl);
      if (!tokenRes.ok) return [];
      const { token } = await tokenRes.json();

      // 2. Fetch manifest — accept both v2 single and OCI/Docker manifest lists
      const manifestUrl = `https://registry-1.docker.io/v2/${namespace}/manifests/${encodeURIComponent(tag)}`;
      const manifestRes = await fetch(manifestUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: [
            'application/vnd.docker.distribution.manifest.v2+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.index.v1+json',
          ].join(', '),
        },
      });
      if (!manifestRes.ok) return [];
      const manifest = await manifestRes.json();

      // 3. Resolve config digest — handle manifest list (multi-arch) vs single manifest
      let configDigest: string | null = manifest?.config?.digest ?? null;

      if (!configDigest && Array.isArray(manifest?.manifests)) {
        // Manifest list: pick linux/amd64, fallback to first linux entry
        const entries: {
          digest: string;
          platform?: { os?: string; architecture?: string };
        }[] = manifest.manifests;
        const amd64 =
          entries.find(
            (m) =>
              m.platform?.os === 'linux' &&
              m.platform?.architecture === 'amd64',
          ) ?? entries.find((m) => m.platform?.os === 'linux');

        if (!amd64) return [];

        // Fetch the platform-specific manifest
        const platformManifestRes = await fetch(
          `https://registry-1.docker.io/v2/${namespace}/manifests/${amd64.digest}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: [
                'application/vnd.docker.distribution.manifest.v2+json',
                'application/vnd.oci.image.manifest.v1+json',
              ].join(', '),
            },
          },
        );
        if (!platformManifestRes.ok) return [];
        const platformManifest = await platformManifestRes.json();
        configDigest = platformManifest?.config?.digest ?? null;
      }

      if (!configDigest) return [];

      // 4. Fetch config blob → extract ExposedPorts
      const blobRes = await fetch(
        `https://registry-1.docker.io/v2/${namespace}/blobs/${configDigest}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!blobRes.ok) return [];
      const config = await blobRes.json();

      const exposedPorts: Record<string, unknown> =
        config?.config?.ExposedPorts ?? {};
      return Object.keys(exposedPorts)
        .map((key) => Number.parseInt(key.split('/')[0], 10))
        .filter((port) => !Number.isNaN(port))
        .sort((a, b) => a - b);
    } catch (error) {
      this.logger.warn(
        `inspectImagePorts failed for ${imageRef}: ${error.message}`,
      );
      return [];
    }
  }

  // ─── Namespace / image ref helpers ──────────────────────────────────────────

  /**
   * Resolve namespace for DockerHub API:
   * - 'nginx' → 'library/nginx'
   * - 'myuser/myimage' → 'myuser/myimage'
   */
  private resolveNamespace(image: string): string {
    const clean = image.replace(/^docker\.io\//, '');
    return clean.includes('/') ? clean : `library/${clean}`;
  }

  /**
   * Parse imageRef into image and tag components:
   * - 'nginx:1.25' → { image: 'nginx', tag: '1.25' }
   * - 'nginx' → { image: 'nginx', tag: 'latest' }
   */
  private parseImageRef(imageRef: string): { image: string; tag: string } {
    const colonIdx = imageRef.lastIndexOf(':');
    if (colonIdx === -1) {
      return { image: imageRef, tag: 'latest' };
    }
    const afterColon = imageRef.substring(colonIdx + 1);
    if (afterColon.includes('/')) {
      return { image: imageRef, tag: 'latest' };
    }
    return {
      image: imageRef.substring(0, colonIdx),
      tag: afterColon || 'latest',
    };
  }
}

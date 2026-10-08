import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { RepositoryCredentialEntity } from '../../repositories/entities/repository-credential.entity';
import { GitProvider } from '../../repositories/entities/repository.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { GitHubTokenResolverService } from '../../repositories/services/github-token-resolver.service';
import { GithubAppUserAuthService } from '../../repositories/services/github-app-user-auth.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { ApplicationEntity } from '../entities/application.entity';

/**
 * One pull secret per application, not per namespace: a project's namespace
 * holds the applications of several people, and each pulls with its own
 * owner's credentials. A shared name would let the last deploy overwrite the
 * credentials every other application in the project pulls with.
 */
export function ghcrPullSecretName(appSlug: string): string {
  return `${appSlug}-ghcr-pull`;
}

@Injectable()
export class GhcrSecretRefreshService {
  private readonly logger = new Logger(GhcrSecretRefreshService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(RepositoryCredentialEntity)
    private readonly credentialRepository: Repository<RepositoryCredentialEntity>,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly encryptionService: EncryptionService,
    private readonly kubernetesService: KubernetesService,
    private readonly tokenResolver: GitHubTokenResolverService,
    private readonly userAuth: GithubAppUserAuthService,
  ) {}

  /**
   * Refresh GHCR pull secrets for all active GIT_BUILD apps.
   * Groups by cluster (decrypt kubeconfig once) and by owner (get token once).
   */
  async refreshAll(): Promise<void> {
    const apps = await this.applicationsRepository.findActiveGitBuildApps();
    if (apps.length === 0) {
      this.logger.debug(
        'No active GIT_BUILD apps — skipping pull secret refresh',
      );
      return;
    }

    // Filter to apps with valid imageRef and userId
    const eligible = apps.filter(
      (a) => a.userId && a.imageRef && a.imageRef.split('/').length >= 2,
    );
    if (eligible.length === 0) {
      this.logger.debug('No eligible apps for pull secret refresh');
      return;
    }

    // Group by clusterId
    const byCluster = new Map<string, ApplicationEntity[]>();
    for (const app of eligible) {
      const list = byCluster.get(app.clusterId) ?? [];
      list.push(app);
      byCluster.set(app.clusterId, list);
    }

    // Process all clusters in parallel
    const results = await Promise.allSettled(
      Array.from(byCluster.entries()).map(([clusterId, clusterApps]) =>
        this.refreshCluster(clusterId, clusterApps),
      ),
    );

    const totalRefreshed = results.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0),
      0,
    );

    if (totalRefreshed > 0) {
      this.logger.log(
        `Refreshed pull secrets for ${totalRefreshed} apps across ${byCluster.size} clusters`,
      );
    }
  }

  /**
   * Refresh all pull secrets for a single cluster. Owners are processed in parallel.
   * Returns the number of secrets successfully refreshed.
   */
  private async refreshCluster(
    clusterId: string,
    clusterApps: ApplicationEntity[],
  ): Promise<number> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      this.logger.warn(
        `Cluster ${clusterId} not found or missing kubeconfig — skipping ${clusterApps.length} apps`,
      );
      return 0;
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    // Group by owner (extracted from imageRef: ghcr.io/<owner>/...)
    const byOwner = new Map<string, ApplicationEntity[]>();
    for (const app of clusterApps) {
      const owner = app.imageRef.split('/')[1];
      const list = byOwner.get(owner) ?? [];
      list.push(app);
      byOwner.set(owner, list);
    }

    // Process all owners in parallel
    const results = await Promise.allSettled(
      Array.from(byOwner.entries()).map(([owner, ownerApps]) =>
        this.refreshOwner(kubeconfig, owner, ownerApps),
      ),
    );

    return results.reduce(
      (sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0),
      0,
    );
  }

  /**
   * Refresh pull secrets for all apps of a single owner within a cluster.
   * Fetches the token once, then applies secrets to all namespaces in parallel.
   * Returns the number of secrets successfully refreshed.
   */
  private async refreshOwner(
    kubeconfig: string,
    owner: string,
    ownerApps: ApplicationEntity[],
  ): Promise<number> {
    const fluiUserId = ownerApps[0].userId;
    const resolved = await this.resolvePullCredentials(fluiUserId, owner);
    if (!resolved) {
      this.logger.warn(
        `No usable GHCR credentials for user ${fluiUserId} (owner ${owner}) — skipping`,
      );
      return 0;
    }
    const { username, token } = resolved;

    const dockerConfigJsonBase64 = this.buildDockerConfigBase64(
      username,
      token,
    );

    // Apply secrets to all namespaces in parallel
    const results = await Promise.allSettled(
      ownerApps.map((app) =>
        this.applyPullSecret(
          kubeconfig,
          app.k8sNamespace,
          ghcrPullSecretName(app.slug),
          dockerConfigJsonBase64,
        ),
      ),
    );

    let refreshed = 0;
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        refreshed++;
      } else {
        const err = (results[i] as PromiseRejectedResult).reason;
        this.logger.warn(
          `Failed to refresh pull secret for app ${ownerApps[i].id} in ${ownerApps[i].k8sNamespace}: ${err.message}`,
        );
      }
    }
    return refreshed;
  }

  /**
   * Ensure a GHCR pull secret exists for a single app.
   * Used by the deploy processor at deploy time.
   * Returns the secret name on success, undefined on failure (non-blocking).
   */
  async ensureSecretForApp(
    kubeconfig: string,
    app: ApplicationEntity,
  ): Promise<string | undefined> {
    try {
      const owner = app.imageRef?.split('/')[1];
      if (!owner) {
        this.logger.warn(
          `Cannot extract owner from imageRef "${app.imageRef}" — skipping pull secret`,
        );
        return undefined;
      }

      this.logger.log(
        `[ghcr] ensureSecretForApp: app=${app.id} slug=${app.slug} userId=${app.userId} imageRef=${app.imageRef} ns=${app.k8sNamespace}`,
      );

      const resolved = await this.resolvePullCredentials(app.userId, owner);
      if (!resolved) {
        this.logger.warn(
          `[ghcr] No usable credentials for user ${app.userId} — pull secret not created`,
        );
        return undefined;
      }

      const dockerConfigJsonBase64 = this.buildDockerConfigBase64(
        resolved.username,
        resolved.token,
      );
      const secretName = ghcrPullSecretName(app.slug);
      await this.applyPullSecret(
        kubeconfig,
        app.k8sNamespace,
        secretName,
        dockerConfigJsonBase64,
      );
      this.logger.log(
        `${secretName} ensured in namespace ${app.k8sNamespace} via ${resolved.source}`,
      );
      return secretName;
    } catch (err) {
      this.logger.warn(
        `[ghcr] Failed to create ghcr pull secret for app ${app.id}: ${err.message}`,
      );
      return undefined;
    }
  }

  /**
   * Preference order for the pull secret credentials:
   *
   * 1. **Classic PAT** with `read:packages` scope, saved via the dedicated
   *    `/repositories/github-app/packages-pat` endpoint. This is the ONLY
   *    method officially supported by GitHub for pulling private container
   *    packages outside of GitHub Actions (see community discussion 34084).
   *    Stored as `RepositoryCredentialEntity` with `credentialType=PAT`.
   *
   * 2. **Legacy OAuth credential** (classic `/github/connect` flow): kept for
   *    backward compat with installations that predate the PAT endpoint.
   *
   * 3. **GitHub App U2S token**: works for GitHub API calls on behalf of the
   *    user but does NOT work for GHCR. Included here only as a placeholder
   *    because the auth service exposes it; `ghcr.io` will reject it with
   *    403 `invalid_token`. Kept last-resort so same-owner legacy setups or
   *    public packages may still succeed occasionally.
   *
   * 4. **App installation token** (S2S): final fallback for fully same-owner
   *    setups. Generally fails with 403 in managed multi-tenant usage.
   */
  private async resolvePullCredentials(
    fluiUserId: string | undefined,
    owner: string,
  ): Promise<{ username: string; token: string; source: string } | null> {
    if (!fluiUserId) return null;

    const credential = await this.credentialRepository.findOne({
      where: {
        userId: fluiUserId,
        provider: GitProvider.GITHUB,
        isActive: true,
      },
      order: { createdAt: 'DESC' },
    });
    if (credential?.githubUsername && credential.accessTokenEncrypted) {
      return {
        username: credential.githubUsername,
        token: this.encryptionService.decrypt(credential.accessTokenEncrypted),
        source: `credential:${credential.credentialType ?? 'unknown'}`,
      };
    }

    const u2s = await this.userAuth.getValidToken(fluiUserId);
    if (u2s) {
      return {
        username: u2s.githubLogin,
        token: u2s.accessToken,
        source: 'u2s-oauth',
      };
    }

    if (await this.tokenResolver.isAppMode()) {
      try {
        const token = await this.tokenResolver.getAccessToken(
          fluiUserId,
          owner,
        );
        return {
          username: 'x-access-token',
          token,
          source: 'app-installation',
        };
      } catch (err) {
        this.logger.debug(
          `App installation token fallback failed for owner=${owner}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return null;
  }

  /**
   * Dev diagnostic: HEAD the manifest endpoint for an imageRef with the given
   * token. Helps distinguish "token wrong format" from "App lacks permission".
   */
  private async probeGhcr(
    imageRef: string | null | undefined,
    token: string,
  ): Promise<{ url: string; status: number; wwwAuth: string | null }> {
    if (!imageRef) return { url: '(no-imageRef)', status: 0, wwwAuth: null };
    const [, owner, name] = imageRef.split('/');
    const repo = name?.split(':')[0];
    const tag = name?.split(':')[1] ?? 'latest';
    const url = `https://ghcr.io/v2/${owner}/${repo}/manifests/${tag}`;
    try {
      const resp = await fetch(url, {
        method: 'HEAD',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.oci.image.manifest.v1+json',
        },
      });
      return {
        url,
        status: resp.status,
        wwwAuth: resp.headers.get('www-authenticate'),
      };
    } catch (err) {
      return {
        url,
        status: -1,
        wwwAuth: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildDockerConfigBase64(username: string, token: string): string {
    const authBase64 = Buffer.from(`${username}:${token}`).toString('base64');
    const dockerConfigJson = JSON.stringify({
      auths: { 'ghcr.io': { auth: authBase64 } },
    });
    return Buffer.from(dockerConfigJson).toString('base64');
  }

  private async applyPullSecret(
    kubeconfig: string,
    namespace: string,
    secretName: string,
    dockerConfigJsonBase64: string,
  ): Promise<void> {
    const manifest = [
      'apiVersion: v1',
      'kind: Secret',
      'metadata:',
      `  name: ${secretName}`,
      `  namespace: ${namespace}`,
      'type: kubernetes.io/dockerconfigjson',
      'data:',
      `  .dockerconfigjson: ${dockerConfigJsonBase64}`,
    ].join('\n');

    await this.kubernetesService.applyManifest(kubeconfig, manifest);
  }
}

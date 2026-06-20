import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { CACHE_PROFILES, detectCacheEngine } from '../engine/cache-engine';
import {
  CacheResolveInput,
  ResolvedCacheConnection,
} from '../interfaces/cache-connection';

/**
 * Resolves how to reach an installed cache server. No credentials — Memcached is
 * unauthenticated; the boundary is the cluster-internal port + the port-forward.
 */
@Injectable()
export class CacheConnectionResolver {
  constructor(private readonly applicationsRepo: ApplicationsRepository) {}

  async resolve({
    appId,
  }: CacheResolveInput): Promise<ResolvedCacheConnection> {
    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(`Cache application ${appId} not found`);
    }
    const engine = detectCacheEngine(app.imageRef);
    if (!engine) {
      throw new BadRequestException(
        `Application ${app.id} is not a supported cache server`,
      );
    }
    const profile = CACHE_PROFILES[engine];
    return {
      engine,
      target: {
        clusterId: app.clusterId,
        namespace: app.k8sNamespace,
        podLabelSelector: `flui-app-id=${app.id}`,
        port: profile.port,
      },
    };
  }
}

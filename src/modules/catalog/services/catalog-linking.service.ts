import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { CatalogAppDefinitionRepository } from '../repositories/catalog-app-definition.repository';
import { CatalogInstallRepository } from '../repositories/catalog-install.repository';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import {
  CatalogLinkedBuildingBlock,
  CatalogSpecBuildingBlock,
} from '../interfaces/catalog-manifest.interface';
import {
  LinkedEnvError,
  resolveLinkedEnvEntries,
} from '../../attached-services/attached-service-env.core';
import { BlockConnectionUrlService } from './block-connection-url.service';
import { ApplicationEnvVar } from '../../applications/interfaces/source-config.interface';

export type { ResolvedLinkedEnv } from '../../attached-services/attached-service-env.core';
import type { ResolvedLinkedEnv } from '../../attached-services/attached-service-env.core';

/**
 * Resolves the env vars a catalog client (e.g. pgweb) needs to talk to a
 * running building block (e.g. postgresql). Secrets are emitted as
 * `externalSecretRef` pointing to the BB's K8s Secret so passwords never
 * leave the cluster.
 *
 * Used from two places:
 *   - `CatalogInstallerService.connect` at Connect time (primary path)
 *   - integration/e2e tests
 */
@Injectable()
export class CatalogLinkingService {
  private readonly logger = new Logger(CatalogLinkingService.name);

  constructor(
    private readonly installRepo: CatalogInstallRepository,
    private readonly definitionRepo: CatalogAppDefinitionRepository,
    private readonly applicationsRepo: ApplicationsRepository,
    private readonly blockConnectionUrl: BlockConnectionUrlService,
  ) {}

  async resolveLinkedEnv(
    clientClusterId: string,
    linkedInstallId: string,
    linkedBlocks: CatalogLinkedBuildingBlock[],
  ): Promise<ResolvedLinkedEnv[]> {
    const bbInstall = await this.installRepo.findById(linkedInstallId);
    if (!bbInstall) {
      throw new BadRequestException(
        `Linked building-block install ${linkedInstallId} not found`,
      );
    }
    if (bbInstall.clusterId !== clientClusterId) {
      throw new BadRequestException(
        `Cross-cluster linking not supported: client on ${clientClusterId}, BB on ${bbInstall.clusterId}`,
      );
    }
    if (!bbInstall.applicationIds?.length) {
      throw new BadRequestException(
        `Linked building-block ${bbInstall.id} has no application yet (still installing?)`,
      );
    }
    const bbDefinition = await this.definitionRepo.findById(
      bbInstall.catalogAppDefinitionId,
    );
    if (!bbDefinition) {
      throw new BadRequestException(
        `Linked BB definition ${bbInstall.catalogAppDefinitionId} not found`,
      );
    }
    const linked = linkedBlocks.find((l) => l.ref === bbDefinition.slug);
    if (!linked) {
      throw new BadRequestException(
        `Client manifest does not declare linkedBuildingBlocks for BB "${bbDefinition.slug}" (declared refs: ${linkedBlocks.map((l) => l.ref).join(', ') || 'none'})`,
      );
    }
    const bbApp = await this.applicationsRepo.findById(
      bbInstall.applicationIds[0],
    );
    if (!bbApp) {
      throw new BadRequestException(
        `Linked building-block application ${bbInstall.applicationIds[0]} not found`,
      );
    }

    const bbSpec = bbDefinition.manifest.spec as CatalogSpecBuildingBlock;
    const bbSecretName = `${bbApp.slug}-secret`;

    // `fromService: url` is the only branch that needs something to EXIST before
    // it can be read: the block's Secret has to carry the URL. Ask for it only
    // when a mapping wants it, so a plain host/port link never touches a Secret.
    const wantsUrl = linked.envMapping.some((e) => e.fromService === 'url');
    const connectionUrlKey = wantsUrl
      ? await this.blockConnectionUrl.ensureOnExisting(bbApp, bbSpec.engine)
      : null;

    let out: ResolvedLinkedEnv[];
    try {
      out = resolveLinkedEnvEntries(linked.envMapping, {
        ref: bbDefinition.slug,
        host: `${bbApp.slug}-svc.${bbApp.k8sNamespace}.svc.cluster.local`,
        port: bbSpec.ports[0]?.internal,
        secretName: bbSecretName,
        declaredEnv: bbSpec.env.map((e) => ({
          name: e.name,
          secret: isSecretDeclaration(e),
        })),
        appEnv: Object.fromEntries(
          ((bbApp.env as ApplicationEnvVar[] | undefined) ?? [])
            .filter((e) => !e.secret && !e.externalSecretRef)
            .map((e) => [e.name, e.value ?? '']),
        ),
        connectionUrlKey,
      });
    } catch (err) {
      if (err instanceof LinkedEnvError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    this.logger.log(
      `resolveLinkedEnv(→ ${bbApp.slug}): ${out.length} env entries (${out.filter((e) => e.externalSecretRef).length} secretKeyRef)`,
    );
    return out;
  }
}

/**
 * A block env is a secret when the block generates it or asks a person for a
 * sensitive value. Unchanged from what this file tested inline before the chain
 * moved into the core — a `secret: true` with no `valueFrom` stays public here,
 * as it always has, because widening it would turn plain values into dangling
 * secretKeyRefs on links that work today.
 */
function isSecretDeclaration(e: { valueFrom?: unknown }): boolean {
  const vf = e.valueFrom as Record<string, any> | undefined;
  if (!vf) return false;
  return 'generate' in vf || ('userInput' in vf && !!vf.userInput?.sensitive);
}

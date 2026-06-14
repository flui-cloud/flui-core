import { Injectable, NotFoundException, HttpException } from '@nestjs/common';
import { CatalogAppDefinitionRepository } from '../repositories/catalog-app-definition.repository';
import { CatalogAppDefinitionEntity } from '../entities/catalog-app-definition.entity';
import { CatalogResponseDto } from '../dto/catalog-response.dto';
import { CatalogClientResponseDto } from '../dto/catalog-client-response.dto';
import {
  CatalogDetailResponseDto,
  CatalogDependencyDto,
  CatalogEditableEnvDto,
  CatalogUserInputPromptDto,
  CatalogResourcesDto,
} from '../dto/catalog-detail-response.dto';
import { CatalogClusterCapabilitiesDto } from '../dto/catalog-cluster-capabilities.dto';
import {
  CatalogAuthMode,
  CatalogEnvVar,
  CatalogManifest,
  CatalogSpecStandalone,
  CatalogSpecBuildingBlock,
  CatalogSpecComposed,
} from '../interfaces/catalog-manifest.interface';
import { CatalogAppType } from '../enums/catalog-app-type.enum';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { ClusterDnsZoneService } from '../../dns/services/cluster-dns-zone.service';
import {
  internalHostingNotAvailableException,
  INTERNAL_HOSTING_ERROR_CODE,
} from '../../dns/constants/internal-hosting-error';
import { CatalogManifestLoaderService } from './catalog-manifest-loader.service';
import { buildUpsertPayload } from './catalog-seeder.service';
import { CatalogValidateResponseDto } from '../dto/catalog-validate.dto';
import { CatalogInstallEntity } from '../entities/catalog-install.entity';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';

type CatalogSpecAny =
  | CatalogSpecStandalone
  | CatalogSpecBuildingBlock
  | CatalogSpecComposed;

@Injectable()
export class CatalogService {
  constructor(
    private readonly repository: CatalogAppDefinitionRepository,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly manifestLoader: CatalogManifestLoaderService,
    private readonly applicationsRepo: ApplicationsRepository,
  ) {}

  /**
   * Resolve the BB install a client is CURRENTLY connected to by inspecting
   * the env of the client's Application — the only source of truth. The
   * pattern is: env entries with `externalSecretRef.secretName === "<bbAppSlug>-secret"`
   * unambiguously identify the BB Application, whose metadata.catalogInstallId
   * is the answer.
   *
   * Returns null when:
   *   - the install has no application yet
   *   - the application has no externalSecretRef env (unlinked / disconnected)
   *   - the referenced BB Application can no longer be resolved (BB deleted)
   *
   * Deliberately no persisted "linkedInstallId" column: env ↔ pod is
   * K8s-level truth, any mirror on the install row would drift.
   */
  async resolveConnectedInstallId(
    install: CatalogInstallEntity,
  ): Promise<string | null> {
    const target = await this.resolveConnectedTarget(install);
    return target?.installId ?? null;
  }

  /**
   * Resolves both the BB install id AND the catalog slug the client is currently
   * connected to, in a single pass through the application env. The slug is a
   * denormalization for the FE: with multi-BB clients (e.g. DbGate) knowing only
   * the install UUID forces a second round-trip to learn whether the connected
   * BB is mariadb, postgresql, or valkey.
   */
  async resolveConnectedTarget(
    install: CatalogInstallEntity,
  ): Promise<{ installId: string; slug: string } | null> {
    const appId = install.applicationIds?.[0];
    if (!appId) return null;
    const app = await this.applicationsRepo.findById(appId);
    if (!app) return null;
    const linkedEnv = (app.env ?? []).find((e) => e.externalSecretRef);
    if (!linkedEnv?.externalSecretRef) return null;
    const bbSecret = linkedEnv.externalSecretRef.secretName;
    if (!bbSecret.endsWith('-secret')) return null;
    const bbAppSlug = bbSecret.slice(0, -'-secret'.length);
    const bbApp = await this.applicationsRepo.findBySlug(bbAppSlug);
    if (!bbApp) return null;
    const installId = bbApp.metadata?.catalogInstallId ?? null;
    if (!installId) return null;
    const catalogSlug = bbApp.labels?.['flui.cloud/catalog-app'];
    if (!catalogSlug) return null;
    return { installId, slug: catalogSlug };
  }

  /**
   * Static validation of a raw flui.yaml string. Does not touch the DB or
   * the cluster; just parses + ajv-validates + computes preview. Used by
   * `POST /catalog/validate` and the `catalog:validate` CLI.
   */
  validateManifest(rawYaml: string): CatalogValidateResponseDto {
    try {
      const { manifest, checksum } = this.manifestLoader.load(rawYaml);
      const base = this.buildResponseFromManifest(manifest);
      const details = this.buildManifestPreview(manifest);
      return {
        valid: true,
        manifest,
        checksum,
        preview: { ...base, ...details, installable: true },
      };
    } catch (err) {
      return {
        valid: false,
        errors: this.extractErrorMessages(err),
      };
    }
  }

  private extractErrorMessages(err: unknown): string[] {
    if (err instanceof HttpException) {
      const response = err.getResponse();
      if (typeof response === 'object' && response !== null) {
        const anyResp = response as {
          message?: string | string[];
          errors?: string[];
        };
        if (Array.isArray(anyResp.errors)) return anyResp.errors;
        if (Array.isArray(anyResp.message)) return anyResp.message;
        if (typeof anyResp.message === 'string') return [anyResp.message];
      }
      return [err.message];
    }
    if (err instanceof Error) return [err.message];
    return [String(err)];
  }

  async getClusterCapabilities(
    clusterId: string,
  ): Promise<CatalogClusterCapabilitiesDto> {
    const assignment =
      await this.clusterDnsZoneService.getZoneAssignment(clusterId);
    const hasDnsZone = !!assignment?.dnsZone?.zoneName;

    const wildcardIssuer = hasDnsZone
      ? await this.clusterDnsZoneService.resolveWildcardIssuer(clusterId)
      : null;
    const hasWildcardIssuer = !!wildcardIssuer;
    const canAutoAssignDomain = hasDnsZone && hasWildcardIssuer;
    const internalHostingStatus =
      await this.clusterDnsZoneService.getInternalHostingStatus(clusterId);

    return {
      clusterId,
      hasDnsZone,
      hasWildcardIssuer,
      canAutoAssignDomain,
      zoneName: assignment?.dnsZone?.zoneName,
      certificateProvider: wildcardIssuer?.certificateProvider,
      autoFqdnTemplate: canAutoAssignDomain
        ? `{install-slug}.${assignment.dnsZone.zoneName}`
        : undefined,
      hasInternalHosting: internalHostingStatus.ready,
      internalHostingMissing: internalHostingStatus.ready
        ? undefined
        : internalHostingStatus.missing,
      internalHostTemplate: internalHostingStatus.ready
        ? `{slug}.internal.${assignment.dnsZone.zoneName}`
        : undefined,
    };
  }

  async listPublic(filters?: {
    category?: string;
    appKind?: ApplicationKind;
    tags?: string[];
    search?: string;
  }): Promise<CatalogResponseDto[]> {
    const entities = await this.repository.listPublished(filters);
    return entities.map((e) => this.toResponse(e));
  }

  async listBuildingBlocks(): Promise<CatalogResponseDto[]> {
    const entities = await this.repository.listBuildingBlocks();
    return entities.map((e) => this.toResponse(e));
  }

  async listClientsOf(
    buildingBlockSlug: string,
  ): Promise<CatalogClientResponseDto[]> {
    const entities = await this.repository.listClientsOf(buildingBlockSlug);
    const enriched = entities.map((e) => ({
      ...this.toResponse(e),
      isDefault: (e.clientDefaultFor ?? []).includes(buildingBlockSlug),
    }));
    // Default first, then alphabetical within each group (already alpha by repo).
    enriched.sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return enriched;
  }

  async getRawYamlBySlug(slug: string): Promise<{
    slug: string;
    version: string;
    checksum: string;
    rawYaml: string;
  }> {
    const entity = await this.repository.findPublishedBySlug(slug);
    if (!entity) {
      throw new NotFoundException(`Catalog app "${slug}" not found`);
    }
    return {
      slug: entity.slug,
      version: entity.version,
      checksum: entity.checksum,
      rawYaml: entity.rawYaml,
    };
  }

  async getDetailBySlug(
    slug: string,
    clusterId?: string,
  ): Promise<CatalogDetailResponseDto> {
    const entity = await this.repository.findPublishedBySlug(slug);
    if (!entity) {
      throw new NotFoundException(`Catalog app "${slug}" not found`);
    }
    const detail = this.toDetailResponse(entity);
    if (clusterId && this.manifestExposureIsInternal(entity.manifest)) {
      const status =
        await this.clusterDnsZoneService.getInternalHostingStatus(clusterId);
      detail.installable = status.ready;
      if (!status.ready) {
        detail.notInstallableReason = INTERNAL_HOSTING_ERROR_CODE;
        detail.notInstallableDetails = status.missing;
      }
    } else {
      detail.installable = true;
    }
    return detail;
  }

  /**
   * Used by `POST /catalog/:slug/install` to gate the request before any
   * row is written or job enqueued. If the catalog app is internal and
   * the cluster lacks internal hosting, throws the structured 400.
   */
  async assertCatalogAppInstallableOnCluster(
    slug: string,
    clusterId: string,
  ): Promise<void> {
    const entity = await this.repository.findPublishedBySlug(slug);
    if (!entity) return; // let the installer raise its own NotFound
    if (!this.manifestExposureIsInternal(entity.manifest)) return;
    const status =
      await this.clusterDnsZoneService.getInternalHostingStatus(clusterId);
    if (!status.ready) {
      throw internalHostingNotAvailableException(clusterId, status.missing);
    }
  }

  /**
   * Building blocks are excluded from internal-hosting gating: they are
   * consumed in-cluster by other apps via Service DNS, never reached from
   * a browser, so they do not need the wildcard internal infrastructure.
   * Only standalone apps with `spec.exposure: internal` (e.g. pgweb) need
   * the `*.internal.<zone>` wildcard and ForwardAuth setup.
   */
  private manifestExposureIsInternal(manifest: CatalogManifest): boolean {
    return (
      manifest.spec.type === CatalogAppType.STANDALONE &&
      manifest.spec.exposure === 'internal'
    );
  }

  async findPublishedBySlug(slug: string): Promise<CatalogAppDefinitionEntity> {
    const entity = await this.repository.findPublishedBySlug(slug);
    if (!entity) {
      throw new NotFoundException(`Catalog app "${slug}" not found`);
    }
    return entity;
  }

  toResponse(entity: CatalogAppDefinitionEntity): CatalogResponseDto {
    return {
      id: entity.id,
      slug: entity.slug,
      name: entity.name,
      version: entity.version,
      category: entity.category,
      appKind: entity.appKind,
      appType: entity.appType,
      tags: entity.tags,
      description: entity.description,
      license: entity.license,
      iconUrl: entity.iconUrl,
      links: entity.links,
      ratings: entity.ratings,
      alternativeTo: entity.alternativeTo,
      maintainedAt: entity.maintainedAt,
      entrypointPath: entity.entrypointPath,
      clientFor: entity.clientFor ?? [],
      clientDefaultFor: entity.clientDefaultFor ?? [],
    };
  }

  private toDetailResponse(
    entity: CatalogAppDefinitionEntity,
  ): CatalogDetailResponseDto {
    const base = this.toResponse(entity);
    return {
      ...base,
      ...this.buildManifestPreview(entity.manifest),
      installable: true,
    };
  }

  /**
   * Pure derivation from a parsed CatalogManifest (no DB access).
   * Used both by the detail response (via entity) and by the validate
   * endpoint / CLI that operate on loose YAML without a persisted row.
   */
  buildManifestPreview(manifest: CatalogManifest): {
    userInputPrompts: CatalogUserInputPromptDto[];
    editableEnv: CatalogEditableEnvDto[];
    dependencies: CatalogDependencyDto[];
    resources: CatalogResourcesDto;
    replicas: number;
    resourceOverridesSupported: boolean;
    exposesPublicEndpoint: boolean;
    exposure: 'public' | 'internal';
    privatizable: boolean;
    workloadKind: 'Deployment' | 'StatefulSet';
    persistenceScope: 'shared' | 'dedicated';
    primaryPort?: number;
    linkedBuildingBlocks?: Array<{ ref: string; envCount: number }>;
    domain?: {
      auto?: boolean;
      userCustomizable?: boolean;
      tls?: boolean;
      hostnameMode?: 'ip' | 'domain';
      certChallenge?: 'http-01' | 'dns-01';
      certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';
    };
    auth?: {
      modes: CatalogAuthMode[];
      default: CatalogAuthMode;
    };
    options?: Array<{
      key: string;
      label: string;
      description?: string;
      default: boolean;
    }>;
  } {
    const spec = manifest.spec;
    const envVars = this.collectEnvVars(spec);
    const ports = this.collectPorts(spec);
    const isBuildingBlock = spec.type === CatalogAppType.BUILDING_BLOCK;
    const standaloneExposure =
      spec.type === CatalogAppType.STANDALONE
        ? (spec.exposure ?? 'public')
        : 'public';
    const exposure: 'public' | 'internal' =
      isBuildingBlock || standaloneExposure === 'internal'
        ? 'internal'
        : 'public';
    const exposesPublicEndpoint =
      exposure === 'public' && ports.some((p) => p.expose === true);
    const privatizable =
      !isBuildingBlock &&
      standaloneExposure !== 'internal' &&
      (spec.type === CatalogAppType.STANDALONE
        ? spec.privatizable !== false
        : false);
    const workloadKind: 'Deployment' | 'StatefulSet' = isBuildingBlock
      ? 'StatefulSet'
      : 'Deployment';
    // spec.persistence lives on standalone / building-block specs; composed
    // specs aggregate per-component, but the catalog detail surfaces a single
    // value so the install wizard can show one consistent hint. Pick
    // dedicated if any layer of the manifest opts in.
    let persistenceScope: 'shared' | 'dedicated' = 'shared';
    if (spec.type === CatalogAppType.COMPOSED) {
      if (spec.components.some((c) => c.persistence?.scope === 'dedicated')) {
        persistenceScope = 'dedicated';
      }
    } else if (spec.persistence?.scope === 'dedicated') {
      persistenceScope = 'dedicated';
    }
    const linkedBBs =
      spec.type === CatalogAppType.STANDALONE && spec.linkedBuildingBlocks
        ? spec.linkedBuildingBlocks.map((l) => ({
            ref: l.ref,
            envCount: l.envMapping.length,
          }))
        : undefined;
    const domainSpec =
      spec.type === CatalogAppType.STANDALONE ||
      spec.type === CatalogAppType.COMPOSED
        ? spec.domain
        : undefined;
    return {
      userInputPrompts: this.buildUserInputPrompts(envVars),
      editableEnv: this.buildEditableEnv(envVars),
      dependencies: this.buildDependencyList(spec),
      resources: this.aggregateResources(spec),
      replicas: this.defaultReplicas(spec),
      // Composed components always deploy at manifest defaults (overrides are not
      // applied per-component), so the override knob would be a no-op — tell the
      // wizard to hide it and show resources read-only.
      resourceOverridesSupported: spec.type !== CatalogAppType.COMPOSED,
      exposesPublicEndpoint,
      exposure,
      privatizable,
      workloadKind,
      persistenceScope,
      primaryPort: ports[0]?.internal,
      linkedBuildingBlocks: linkedBBs,
      domain: domainSpec
        ? {
            auto: domainSpec.auto,
            userCustomizable: domainSpec.userCustomizable,
            tls: domainSpec.tls,
            hostnameMode: domainSpec.hostnameMode,
            certChallenge: domainSpec.certChallenge,
            certificateProvider: domainSpec.certificateProvider,
          }
        : undefined,
      auth: this.buildAuthPreview(spec),
      options: this.buildOptionsPreview(spec),
    };
  }

  private buildOptionsPreview(spec: CatalogSpecAny):
    | Array<{
        key: string;
        label: string;
        description?: string;
        default: boolean;
      }>
    | undefined {
    if (spec.type !== CatalogAppType.COMPOSED || !spec.options?.length) {
      return undefined;
    }
    return spec.options.map((o) => ({
      key: o.key,
      label: o.label,
      description: o.description,
      default: o.default ?? false,
    }));
  }

  /**
   * Surface the manifest's selectable auth modes + initial default so the
   * install wizard can render an auth-mode selector. `spec.auth` lives on
   * every spec type. Returns undefined when the manifest declares no auth,
   * leaving the install to the backend default (native).
   */
  private buildAuthPreview(
    spec: CatalogSpecAny,
  ): { modes: CatalogAuthMode[]; default: CatalogAuthMode } | undefined {
    const auth = spec.auth;
    if (!auth) return undefined;
    const single = auth.mode ?? auth.default;
    const declared = auth.modes ?? (single ? [single] : []);
    const modes = [...new Set(declared)];
    if (modes.length === 0) return undefined;
    return { modes, default: auth.default ?? auth.mode ?? modes[0] };
  }

  private collectPorts(
    spec: CatalogSpecAny,
  ): Array<{ internal: number; expose: boolean }> {
    if (spec.type === CatalogAppType.COMPOSED) {
      return spec.components.flatMap((c) =>
        (c.ports ?? []).map((p) => ({
          internal: p.internal,
          expose: p.expose,
        })),
      );
    }
    return (spec.ports ?? []).map((p) => ({
      internal: p.internal,
      expose: p.expose,
    }));
  }

  /**
   * Aggregate resources declared by the manifest. For standalone and
   * building-block apps this is a straight copy of `spec.resources`. For
   * composed apps it's the component-wise sum: CPU/memory are parsed into
   * canonical units (millicores, MiB), summed, and re-formatted back into
   * human-readable strings. The result is what the frontend must feed into
   * the cluster resource-availability endpoint — never a generic "profile".
   */
  private aggregateResources(spec: CatalogSpecAny): CatalogResourcesDto {
    if (spec.type !== CatalogAppType.COMPOSED) {
      return {
        requests: {
          cpu: spec.resources?.requests?.cpu,
          memory: spec.resources?.requests?.memory,
        },
        limits: {
          cpu: spec.resources?.limits?.cpu,
          memory: spec.resources?.limits?.memory,
        },
      };
    }

    // Composed: sum across components.
    let cpuReqMc = 0;
    let memReqMi = 0;
    let cpuLimMc = 0;
    let memLimMi = 0;
    for (const c of spec.components) {
      cpuReqMc += this.parseCpuToMc(c.resources?.requests?.cpu);
      memReqMi += this.parseMemoryToMi(c.resources?.requests?.memory);
      cpuLimMc += this.parseCpuToMc(c.resources?.limits?.cpu);
      memLimMi += this.parseMemoryToMi(c.resources?.limits?.memory);
    }
    return {
      requests: {
        cpu: cpuReqMc > 0 ? `${cpuReqMc}m` : undefined,
        memory: memReqMi > 0 ? `${memReqMi}Mi` : undefined,
      },
      limits: {
        cpu: cpuLimMc > 0 ? `${cpuLimMc}m` : undefined,
        memory: memLimMi > 0 ? `${memLimMi}Mi` : undefined,
      },
    };
  }

  private defaultReplicas(spec: CatalogSpecAny): number {
    if (spec.type === CatalogAppType.COMPOSED) {
      // Composed stacks: frontend should compute capacity per-component,
      // reporting aggregate 1 by default as a simplification.
      return 1;
    }
    const h = spec.scaling?.horizontal;
    if (h?.enabled && typeof h.min === 'number') return h.min;
    return 1;
  }

  /** Parses K8s CPU value ("500m", "1", "2") into millicores. Returns 0 on missing/invalid. */
  private parseCpuToMc(value: string | undefined): number {
    if (!value) return 0;
    const v = value.trim();
    if (v.endsWith('m')) return Number.parseInt(v.slice(0, -1), 10) || 0;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
  }

  /** Parses K8s memory value ("512Mi", "2Gi", "1024Ki") into MiB. Returns 0 on missing/invalid. */
  private parseMemoryToMi(value: string | undefined): number {
    if (!value) return 0;
    const v = value.trim();
    const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(v);
    if (!m) return 0;
    const n = Number.parseFloat(m[1]);
    if (!Number.isFinite(n)) return 0;
    switch (m[2]) {
      case 'Ki':
        return Math.round(n / 1024);
      case 'Mi':
        return Math.round(n);
      case 'Gi':
        return Math.round(n * 1024);
      case 'Ti':
        return Math.round(n * 1024 * 1024);
      case 'K':
        return Math.round((n * 1000) / (1024 * 1024));
      case 'M':
        return Math.round((n * 1000 * 1000) / (1024 * 1024));
      case 'G':
        return Math.round((n * 1000 * 1000 * 1000) / (1024 * 1024));
      case 'T':
        return Math.round((n * 1000 * 1000 * 1000 * 1000) / (1024 * 1024));
      default:
        // Plain bytes
        return Math.round(n / (1024 * 1024));
    }
  }

  buildResponseFromManifest(manifest: CatalogManifest): CatalogResponseDto {
    const md = manifest.metadata;
    return {
      id: '',
      slug: md.id,
      name: md.name,
      version: md.version,
      category: md.category,
      appKind: md.appKind,
      appType: manifest.spec.type as CatalogAppType,
      tags: md.tags ?? [],
      description: md.description,
      license: md.license,
      iconUrl: md.icon,
      links: md.links,
      ratings: md.ratings,
      alternativeTo: md.alternativeTo ?? [],
      maintainedAt: md.maintainedAt,
      entrypointPath: md.entrypointPath,
      clientFor: md.clientFor ?? [],
      clientDefaultFor: md.clientDefaultFor ?? [],
    };
  }

  private collectEnvVars(spec: CatalogSpecAny): CatalogEnvVar[] {
    if (spec.type === CatalogAppType.COMPOSED) {
      return spec.components.flatMap((c) => c.env);
    }
    return spec.env;
  }

  private buildUserInputPrompts(
    envVars: CatalogEnvVar[],
  ): CatalogUserInputPromptDto[] {
    return envVars
      .filter((e) => !!e.valueFrom && 'userInput' in e.valueFrom)
      .map((e) => {
        const userInput = (
          e.valueFrom as { userInput: NonNullable<CatalogEnvVar['valueFrom']> }
        )
          .userInput as import('../interfaces/catalog-manifest.interface').CatalogUserInputPrompt;
        return {
          name: e.name,
          label: userInput.label,
          default: userInput.default,
          sensitive: userInput.sensitive ?? false,
          description: e.description,
          placeholder: userInput.placeholder,
          pattern: userInput.pattern,
          patternDescription: userInput.patternDescription,
          minLength: userInput.minLength,
          maxLength: userInput.maxLength,
          confirm: userInput.confirm,
          format: userInput.format,
        };
      });
  }

  private buildEditableEnv(envVars: CatalogEnvVar[]): CatalogEditableEnvDto[] {
    return envVars
      .filter((e) => e.userEditable === true)
      .map((e) => ({
        name: e.name,
        default: e.value,
        description: e.description,
      }));
  }

  private buildDependencyList(spec: CatalogSpecAny): CatalogDependencyDto[] {
    if (
      (spec.type === CatalogAppType.STANDALONE ||
        spec.type === CatalogAppType.BUILDING_BLOCK) &&
      spec.dependencies
    ) {
      return spec.dependencies.map((d) => ({
        ref: d.ref,
        as: d.as,
        required: d.required ?? true,
        reuseExisting: d.reuseExisting ?? false,
      }));
    }
    return [];
  }

  /**
   * Parses rawYaml, validates it against the flui/v1 schema, upserts the
   * app definition in the catalog DB, and returns the persisted entity.
   * Used by `POST /catalog/install-from-yaml` so the caller can install
   * directly from a local file without a prior boot-time seed.
   */
  async upsertFromYaml(rawYaml: string): Promise<CatalogAppDefinitionEntity> {
    const { manifest, checksum } = this.manifestLoader.load(rawYaml);
    const existing = await this.repository.findBySlugAndVersion(
      manifest.metadata.id,
      manifest.metadata.version,
    );
    if (existing?.checksum === checksum) {
      return existing;
    }
    await this.repository.upsert(
      buildUpsertPayload(manifest, rawYaml, checksum),
    );
    await this.repository.cleanupPreviousVersions(
      manifest.metadata.id,
      manifest.metadata.version,
    );
    const entity = await this.repository.findPublishedBySlug(
      manifest.metadata.id,
    );
    if (!entity) {
      throw new NotFoundException(
        `Upsert succeeded but slug "${manifest.metadata.id}" not found — this should not happen`,
      );
    }
    return entity;
  }
}

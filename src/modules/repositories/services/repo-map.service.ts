/**
 * The map, read-only: repository → `RepoMap` → verdict → one rendered
 * `flui.yaml` per unit. Nothing here writes, deploys or provisions.
 *
 * Three rules this file exists to keep.
 *
 * **One way to read a repository.** The archive reader the manifest checks
 * already use (`RepoTreeReaderService`) is the only way in: one `.tar.gz` of
 * one commit, held in memory, ceilings applied while decoding, symlinks
 * refused. A second reader would be a second security posture.
 *
 * **A failure to read is an answer.** `mapFor` never throws for a repository
 * it could not reach, decode or survey: it answers with `read.ok: false`, the
 * reason, and a `not_assessed` verdict. A 500 would say the server broke; what
 * broke is that the repository could not be read, which is a fact about the
 * repository the caller needs to see.
 *
 * **The verdict is a function of (repository, cluster).** With no cluster in
 * the request only the repository half is computed, and `capacity.assessed`
 * says so — a `deployable` that was never weighed against a cluster must never
 * read as one that was. When a cluster *is* named, only footprints somebody
 * actually declared are summed (a catalog block's own `resources`, the
 * platform's default for a unit that declares none); anything that would run
 * and could not be weighed is named in `uncounted` rather than silently
 * counted as nothing.
 */

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  assessCapacity,
  buildRepoMap,
  computeVerdict,
  renderRepoMap,
} from '@flui-cloud/cartographer';
import type {
  ClusterCapacityInput,
  ComponentFootprint,
  RenderResult,
  RepoMap,
  VerdictResult,
} from '@flui-cloud/cartographer';
import {
  RepoTreeReaderService,
  type RepoTreeReadResult,
} from '../../applications/services/repo-tree-reader.service';
import { DEFAULT_REPO_SNAPSHOT_LIMITS } from '../../applications/services/repo-archive-scan.util';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { CatalogAppDefinitionEntity } from '../../catalog/entities/catalog-app-definition.entity';
import { CatalogAppType } from '../../catalog/enums/catalog-app-type.enum';
import type {
  CatalogResources,
  CatalogScaling,
} from '../../catalog/interfaces/catalog-manifest.interface';
import {
  parseCpuMillicores,
  parseMemoryMB,
} from '../../topology/services/topology-k8s.helper';
import {
  CapacityComponentDto,
  ClusterCapacityDto,
  RepositoryMapResponseDto,
} from '../dto/repository-map.dto';

/**
 * What a unit with no declared resources actually asks the cluster for.
 *
 * Not a guess: `application-manifest-generator.service.ts` writes exactly
 * these when `app.resources` is empty, and the render this endpoint produces
 * never writes resources (`render.ts`: what the map does not carry, the render
 * does not write). CPU on the *request* and memory on the *limit* is the same
 * asymmetry the capacity gate uses everywhere else.
 */
const UNIT_DEFAULT_CPU_REQUEST_MILLICORES = 100;
const UNIT_DEFAULT_MEMORY_LIMIT_MEBIBYTES = 256;
const UNIT_FOOTPRINT_BASIS =
  'platform default for an application that declares no resources (100m CPU request, 256Mi memory limit)';

export interface RepoMapRequest {
  owner: string;
  repo: string;
  ref: string;
  repositoryId: string;
  clusterId?: string;
}

@Injectable()
export class RepoMapService {
  private readonly logger = new Logger(RepoMapService.name);

  constructor(
    private readonly treeReader: RepoTreeReaderService,
    private readonly kubernetesService: KubernetesService,
    @Inject(forwardRef(() => ClustersService))
    private readonly clustersService: ClustersService,
    @InjectRepository(CatalogAppDefinitionEntity)
    private readonly catalogDefinitions: Repository<CatalogAppDefinitionEntity>,
  ) {}

  async mapFor(
    userId: string,
    request: RepoMapRequest,
  ): Promise<RepositoryMapResponseDto> {
    const repoFullName = `${request.owner}/${request.repo}`;

    let tree: RepoTreeReadResult;
    try {
      tree = await this.treeReader.readTree(
        userId,
        request.owner,
        request.repo,
        request.ref,
        DEFAULT_REPO_SNAPSHOT_LIMITS,
      );
    } catch (error) {
      this.logger.warn(
        `Could not read ${repoFullName}@${request.ref}: ${error?.message}`,
      );
      tree = {
        read: false,
        reason: 'unreadable',
        repoFullName,
        ref: request.ref,
      };
    }

    if (tree.read === false) {
      return this.unreadResponse(request, tree.reason);
    }

    let map: RepoMap;
    try {
      map = buildRepoMap(tree.scan);
    } catch (error) {
      // A survey that threw read nothing usable. Saying so is an answer; a 500
      // would blame the caller for our own defect.
      this.logger.warn(
        `Could not map ${repoFullName}@${tree.commitSha}: ${error?.message}`,
      );
      const unread = this.unreadResponse(request, 'unreadable');
      unread.read.commitSha = tree.commitSha;
      return unread;
    }

    const render: RenderResult = renderRepoMap(map);
    const capacity = await this.capacityFor(map, render, request.clusterId);
    const verdict: VerdictResult = computeVerdict(map, capacity.input);

    return {
      repositoryId: request.repositoryId,
      repoFullName,
      branch: request.ref,
      read: {
        ok: true,
        repoFullName,
        ref: tree.ref,
        commitSha: tree.commitSha,
        truncated: tree.truncated,
        contentComplete: tree.contentComplete,
        skipped: tree.skipped,
        bytesRead: tree.bytesRead,
        highDensityUnread: tree.highDensityUnread,
        limits: {
          maxArchiveBytes: DEFAULT_REPO_SNAPSHOT_LIMITS.maxArchiveBytes,
          maxContentBytes: DEFAULT_REPO_SNAPSHOT_LIMITS.maxContentBytes,
          maxFileBytes: DEFAULT_REPO_SNAPSHOT_LIMITS.maxFileBytes,
          maxEntries: DEFAULT_REPO_SNAPSHOT_LIMITS.maxEntries,
          timeoutMs: DEFAULT_REPO_SNAPSHOT_LIMITS.timeoutMs,
        },
      },
      map: {
        units: map.units,
        services: map.services,
        inputs: map.inputs,
        externals: map.externals,
        blockers: map.blockers,
        caveats: map.caveats,
        questions: map.questions,
        decisions: map.decisions,
        coverage: map.coverage,
        boundary: map.boundary,
      },
      verdict: {
        outcome: verdict.outcome,
        reason: verdict.reason,
        remedy: verdict.remedy,
        evidence: verdict.evidence,
        units: verdict.units,
        capacity: capacity.reported,
      },
      render: {
        units: render.units.map((unit) => ({
          unitId: unit.unitId,
          name: unit.name,
          manifest: unit.manifest,
          yaml: unit.yaml,
        })),
        skipped: render.skipped,
        notes: render.notes,
      },
    };
  }

  /**
   * A repository that could not be read still gets a finished answer: the
   * reason, and the one verdict that is true of it.
   */
  private unreadResponse(
    request: RepoMapRequest,
    reason: string,
  ): RepositoryMapResponseDto {
    const repoFullName = `${request.owner}/${request.repo}`;
    return {
      repositoryId: request.repositoryId,
      repoFullName,
      branch: request.ref,
      read: {
        ok: false,
        reason,
        repoFullName,
        ref: request.ref,
        limits: {
          maxArchiveBytes: DEFAULT_REPO_SNAPSHOT_LIMITS.maxArchiveBytes,
          maxContentBytes: DEFAULT_REPO_SNAPSHOT_LIMITS.maxContentBytes,
          maxFileBytes: DEFAULT_REPO_SNAPSHOT_LIMITS.maxFileBytes,
          maxEntries: DEFAULT_REPO_SNAPSHOT_LIMITS.maxEntries,
          timeoutMs: DEFAULT_REPO_SNAPSHOT_LIMITS.timeoutMs,
        },
      },
      map: null,
      verdict: {
        outcome: 'not_assessed',
        reason: `the repository could not be read (${reason}), so nothing about it was assessed.`,
        remedy:
          UNREAD_REMEDY[reason] ?? 'Retry once the repository can be read.',
        evidence: [],
        units: [],
        capacity: {
          assessed: false,
          clusterId: request.clusterId ?? null,
          notAssessedReason: 'repository-unreadable',
          assessment: { known: false },
          components: [],
          uncounted: [],
        },
      },
      render: null,
    };
  }

  /**
   * The cluster half, or an honest statement that there is none.
   *
   * Two figures are summed only when somebody declared them: a catalog block's
   * own `resources`, and the platform default a unit with no declared
   * resources is deployed with. A service whose block the catalog does not
   * carry is named in `uncounted` — counting it as zero is how a `fits` that
   * does not hold gets produced.
   */
  private async capacityFor(
    map: RepoMap,
    render: RenderResult,
    clusterId?: string,
  ): Promise<{ input: ClusterCapacityInput; reported: ClusterCapacityDto }> {
    const notAssessed = (
      reason: string,
    ): { input: ClusterCapacityInput; reported: ClusterCapacityDto } => ({
      input: { known: false },
      reported: {
        assessed: false,
        clusterId: clusterId ?? null,
        notAssessedReason: reason,
        assessment: { known: false },
        components: [],
        uncounted: [],
      },
    });

    if (!clusterId) return notAssessed('no-cluster-in-request');

    const { components, uncounted } = await this.footprints(map, render);
    if (components.length === 0) {
      const empty = notAssessed('no-declared-footprint');
      empty.reported.uncounted = uncounted;
      return empty;
    }

    let total: { cpu: number; memory: number };
    let used: { cpu: number; memory: number };
    try {
      const kubeconfig = await this.clustersService.getKubeconfig(clusterId);
      [total, used] = await Promise.all([
        this.kubernetesService.getNodeAllocatable(kubeconfig),
        this.kubernetesService.getPodResourceRequests(kubeconfig),
      ]);
    } catch (error) {
      this.logger.warn(
        `Could not read capacity of cluster ${clusterId}: ${error?.message}`,
      );
      const unreadable = notAssessed('cluster-unreadable');
      unreadable.reported.components = components;
      unreadable.reported.uncounted = uncounted;
      return unreadable;
    }

    const input: ClusterCapacityInput = {
      known: true,
      totalCpuMillicores: total.cpu,
      totalMemoryMebibytes: total.memory,
      usedCpuMillicores: used.cpu,
      usedMemoryMebibytes: used.memory,
      components: components.map(
        (c): ComponentFootprint => ({
          label: c.label,
          cpuRequestMillicores: c.cpuRequestMillicores,
          memoryLimitMebibytes: c.memoryLimitMebibytes,
          replicas: c.replicas,
          unit: c.unit,
        }),
      ),
    };

    const assessment = assessCapacity(input);
    return {
      input,
      reported: {
        assessed: true,
        clusterId,
        notAssessedReason: null,
        assessment,
        components,
        uncounted,
      },
    };
  }

  private async footprints(
    map: RepoMap,
    render: RenderResult,
  ): Promise<{ components: CapacityComponentDto[]; uncounted: string[] }> {
    const components: CapacityComponentDto[] = [];
    const uncounted: string[] = [];

    // Only what would actually run: a unit the render could not turn into a
    // manifest is not deployed, and weighing it would inflate the requirement.
    for (const unit of render.units) {
      components.push({
        label: `unit \`${unit.unitId}\``,
        unit: unit.unitId,
        cpuRequestMillicores: UNIT_DEFAULT_CPU_REQUEST_MILLICORES,
        memoryLimitMebibytes: UNIT_DEFAULT_MEMORY_LIMIT_MEBIBYTES,
        replicas: 1,
        basis: UNIT_FOOTPRINT_BASIS,
      });
    }

    for (const service of map.services) {
      const label = `service \`${service.name}\``;
      if (!service.block) {
        uncounted.push(
          `${label}: no catalog block answers it, so there is nothing to weigh`,
        );
        continue;
      }
      const definition = await this.catalogDefinitions
        .findOne({
          where: { slug: service.block, isActive: true },
          order: { createdAt: 'DESC' },
        })
        .catch(() => null);
      if (!definition) {
        uncounted.push(
          `${label}: block \`${service.block}\` is not in this installation's catalog`,
        );
        continue;
      }
      const footprint = this.footprintOfDefinition(definition);
      if (!footprint) {
        uncounted.push(
          `${label}: block \`${service.block}\` declares no resources`,
        );
        continue;
      }
      components.push({
        label,
        unit: service.unit,
        cpuRequestMillicores: footprint.cpu,
        memoryLimitMebibytes: footprint.memory,
        replicas: footprint.replicas,
        basis: `catalog block \`${service.block}\` (${definition.version}) declares them`,
      });
    }

    return { components, uncounted };
  }

  /** CPU on the request, memory on the limit — the same asymmetry the install
   * gate applies, and the reason a memory *request* is only a fallback here. */
  private footprintOfDefinition(
    definition: CatalogAppDefinitionEntity,
  ): { cpu: number; memory: number; replicas: number } | null {
    const spec = definition.manifest?.spec;
    if (!spec) return null;
    const parts: Array<{
      resources: CatalogResources;
      scaling: CatalogScaling;
    }> =
      spec.type === CatalogAppType.COMPOSED
        ? spec.components.map((c) => ({
            resources: c.resources,
            scaling: c.scaling,
          }))
        : [{ resources: spec.resources, scaling: spec.scaling }];

    let cpu = 0;
    let memory = 0;
    for (const part of parts) {
      const partReplicas = part.scaling?.horizontal?.enabled
        ? (part.scaling.horizontal.min ?? 1)
        : 1;
      cpu += parseCpuMillicores(part.resources?.requests?.cpu) * partReplicas;
      memory +=
        parseMemoryMB(
          part.resources?.limits?.memory ?? part.resources?.requests?.memory,
        ) * partReplicas;
    }
    if (cpu === 0 && memory === 0) return null;
    // Replicas are already folded into the sums above, so the footprint this
    // hands back is for one installation of the block, not one pod of it.
    return { cpu, memory, replicas: 1 };
  }
}

const UNREAD_REMEDY: Record<string, string> = {
  'no-credential':
    'Reconnect the GitHub integration for this owner, then run the map again.',
  'not-found':
    'Check that the branch or commit exists and that the connected credential can see this repository.',
  'too-large':
    'The archive is past the read ceiling. Map a smaller subtree, or raise the ceiling for this installation.',
  rejected:
    'The archive was refused (a symlink, a hardlink or a path escaping the archive root). Remove it and push again.',
  unreadable:
    'The repository could not be fetched or decoded within the read budget. Retry, then check the GitHub credential.',
};

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { AppManagementService } from '../../applications/services/app-management.service';
import { AppResourcesConsequenceService } from '../../applications/services/app-resources-consequence.service';
import {
  ContainerRuntimeDetailDto,
  UpdateResourcesDto,
} from '../../applications/dto/app-management.dto';
import { PrometheusQueryService } from '../../observability/services/prometheus-query.service';
import { memoryMiOf } from '../../shared/utils/resource-quantity.util';
import {
  engineMemoryNote,
  formatMi,
  proposeMemory,
} from '../../applications/utils/resource-proposal.core';
import { CrashDiagnosesRepository } from '../repositories/crash-diagnoses.repository';
import { CrashDiagnosisStatusFilter } from '../enums/crash-diagnosis-status-filter.enum';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';
import {
  ResourceProposalDto,
  ResourceProposalResponseDto,
} from '../dto/resource-proposal.dto';

const USAGE_WINDOW = '7d';

@Injectable()
export class ResourceProposalService {
  private readonly logger = new Logger(ResourceProposalService.name);

  constructor(
    private readonly applications: ApplicationsRepository,
    private readonly management: AppManagementService,
    private readonly consequence: AppResourcesConsequenceService,
    private readonly diagnoses: CrashDiagnosesRepository,
    private readonly prometheus: PrometheusQueryService,
  ) {}

  async proposalOf(appId: string): Promise<ResourceProposalResponseDto> {
    const app = await this.applications.findById(appId);
    const runtime = await this.management.getRuntimeStatus(appId);
    const containers = runtime.containers ?? [];
    const main = containers[0];
    if (!main) return { proposal: null, usageRead: false };

    const others = containers.slice(1);
    const podRequestMi = sumMi(containers, 'requests');
    const podLimitMi = sumMi(containers, 'limits');
    const p95Mi = await this.p95Mi(app.slug, app.k8sNamespace);
    const oom = await this.openOom(appId, main.name);

    const proposed = proposeMemory({
      requestMi: podRequestMi,
      limitMi: podLimitMi,
      p95Mi,
      oom: oom
        ? {
            limitMi:
              oom.limitMi + (podLimitMi ?? 0) - (miOf(main.limits.memory) ?? 0),
            diagnosisId: oom.diagnosisId,
          }
        : null,
    });
    if (!proposed) return { proposal: null, usageRead: p95Mi !== null };

    const change: UpdateResourcesDto = { containerName: main.name };
    const mainRequest = miOf(main.requests.memory);
    const mainLimit = miOf(main.limits.memory);
    if (proposed.requestMi !== null && proposed.requestMi !== podRequestMi) {
      change.requests = {
        memory: formatMi(proposed.requestMi - sumMi(others, 'requests')!),
      };
    } else if (mainRequest === null && proposed.requestMi !== null) {
      change.requests = { memory: formatMi(proposed.requestMi) };
    }
    if (proposed.limitMi !== null && proposed.limitMi !== podLimitMi) {
      change.limits = {
        memory: formatMi(proposed.limitMi - (sumMi(others, 'limits') ?? 0)),
      };
    } else if (mainLimit === null && proposed.limitMi !== null) {
      change.limits = { memory: formatMi(proposed.limitMi) };
    }

    const consequence = await this.consequence.consequenceOf(appId, change);
    const replicas = Math.max(
      1,
      runtime.replicas?.desired ?? app.replicas ?? 1,
    );
    const holdsData =
      app.workloadKind === 'StatefulSet' || (app.volumes?.length ?? 0) > 0;
    const restart =
      replicas > 1 && !holdsData
        ? 'Applying replaces the pods one at a time; the application keeps answering.'
        : 'Applying replaces the pod: the application stops until the new one has started, usually under a minute.';

    const proposal: ResourceProposalDto = {
      containerName: main.name,
      currentRequests: { ...main.requests },
      currentLimits: { ...main.limits },
      reasons: proposed.reasons,
      consequence,
      restart,
      configurationNote: change.limits
        ? engineMemoryNote(app.labels?.['flui.cloud/db-engine'])
        : null,
      diagnosisId: proposed.diagnosisId,
    };
    return { proposal, usageRead: p95Mi !== null };
  }

  /**
   * Recomputed rather than taken from the caller, so what is applied is what
   * the evidence says now, not what a page showed an hour ago.
   */
  async apply(
    appId: string,
    actor: { id?: string; name?: string },
  ): Promise<ResourceProposalResponseDto> {
    const { proposal } = await this.proposalOf(appId);
    if (!proposal) {
      throw new ConflictException(
        'Nothing asks for a change any more; the application fits what it has.',
      );
    }
    if (proposal.consequence.problem) {
      throw new ConflictException(proposal.consequence.problem);
    }
    const change: UpdateResourcesDto = {
      containerName: proposal.containerName,
      requests: diff(proposal.currentRequests, proposal.consequence.requests),
      limits: diff(proposal.currentLimits, proposal.consequence.limits),
    };
    await this.management.updateResources(appId, change, {
      actor,
      reason: proposal.reasons.map((r) => r.sentence).join(' '),
      proposal: proposal.reasons.map((r) => r.kind),
    });
    if (proposal.diagnosisId) {
      await this.diagnoses.markResolved(proposal.diagnosisId);
    }
    return this.proposalOf(appId);
  }

  private async p95Mi(slug: string, namespace: string): Promise<number | null> {
    try {
      const res = await this.prometheus.queryInstant(
        `max(quantile_over_time(0.95, flui:app_memory_usage_bytes_by_pod{namespace="${namespace}",label_app_kubernetes_io_name="${slug}"}[${USAGE_WINDOW}]))`,
      );
      const value = res?.data?.result?.[0]?.value?.[1];
      return value === undefined ? null : Number(value) / (1024 * 1024);
    } catch (error) {
      this.logger.warn(
        `Memory use of ${slug} unreadable: ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async openOom(
    appId: string,
    containerName: string,
  ): Promise<{ limitMi: number; diagnosisId: string } | null> {
    const open = await this.diagnoses.findByApplication(appId, {
      status: CrashDiagnosisStatusFilter.UNRESOLVED,
      limit: 20,
    });
    for (const entry of open) {
      const action = entry.suggestedAction;
      const limit = (action?.payload as UpdateResourcesDto | undefined)?.limits
        ?.memory;
      if (action?.type !== SuggestedActionType.RESOURCES || !limit) continue;
      if (entry.containerName && entry.containerName !== containerName)
        continue;
      const limitMi = miOf(limit);
      if (limitMi !== null) return { limitMi, diagnosisId: entry.id };
    }
    return null;
  }
}

function miOf(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    return memoryMiOf(value);
  } catch {
    return null;
  }
}

function sumMi(
  containers: ContainerRuntimeDetailDto[],
  side: 'requests' | 'limits',
): number | null {
  let total = 0;
  for (const c of containers) {
    const value = miOf(c[side].memory);
    if (value === null) {
      if (side === 'limits') return null;
      continue;
    }
    total += value;
  }
  return total;
}

function diff(
  before: { cpu: string | null; memory: string | null },
  after: { cpu: string | null; memory: string | null },
): { memory: string } | undefined {
  return after.memory && after.memory !== before.memory
    ? { memory: after.memory }
    : undefined;
}

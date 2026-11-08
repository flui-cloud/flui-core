import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { ProviderFactory } from '../../../providers/core/factories/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { shapeNameOf } from '../../../providers/core/catalogue/shape-name';
import {
  HaTopologyResolution,
  resolveHaTopology,
} from '../../../providers/core/ha-topology';
import { CreateClusterDto } from '../dto/create-cluster.dto';
import { HaPlanResponseDto } from '../dto/ha-creation-plan.dto';
import {
  CatalogueShape,
  HaCreationAnswer,
  HaCreationPlan,
  planHaCreation,
} from '../utils/ha-creation-plan.core';

/**
 * The size as the provider's catalogue names it: a client may send the id
 * (`109` on Hetzner), and every later reader — the scaling group, the node
 * list, billing — expects the name. Unchanged when the catalogue is unread.
 */
export async function shapeNameVia(
  providers: ProviderFactory | undefined,
  provider: string,
  nodeSize: string,
): Promise<string> {
  if (!nodeSize) return nodeSize;
  try {
    const service = providers?.getProvider(provider as CloudProvider);
    return shapeNameOf(nodeSize, (await service?.getNodeSizes?.(false)) ?? []);
  } catch {
    return nodeSize;
  }
}

/** Only the forced add of a node accepts a region Flui has not measured, so creating one never offers it. */
function unsupportedReason(
  region: string | undefined,
  resolution: HaTopologyResolution,
): string | undefined {
  if (region) {
    return `Flui has not validated a highly available layout for ${region} yet.`;
  }
  return 'reason' in resolution ? resolution.reason : undefined;
}

/**
 * What a cluster across three locations is bought as, from the provider's
 * declared layout and the sizes it has available now in each location.
 */
@Injectable()
export class HaCreationPlanService {
  private readonly logger = new Logger(HaCreationPlanService.name);

  constructor(
    private readonly capabilitiesFactory: CapabilitiesProviderFactory,
    @Optional() private readonly providers?: ProviderFactory,
  ) {}

  /**
   * The servers of a cluster across three locations, decided before anything
   * is bought: a refusal here leaves nothing behind.
   */
  async plan(dto: CreateClusterDto): Promise<HaCreationPlan | null> {
    if (dto.highAvailability !== 'three-locations') return null;
    const { answer } = await this.answer({
      provider: dto.provider,
      region: dto.region,
      shapes: dto.shapes?.length ? dto.shapes : [dto.nodeSize],
      completeLater: dto.completeLater === true,
      workerCount: dto.workerCount,
    });
    if ('refusal' in answer) throw new BadRequestException(answer.refusal);
    const servers = [answer.plan.first, ...answer.plan.servers]
      .map((s) => s.zone + ' ' + s.shape)
      .join(', ');
    const later = answer.plan.later.length
      ? '; later: ' + answer.plan.later.join(', ')
      : '';
    this.logger.log(
      `Cluster ${dto.name} across three locations: ${servers}${later}`,
    );
    return answer.plan;
  }

  /** What creating a cluster across three locations would buy now, without buying it. */
  async preview(query: {
    provider: CloudProvider;
    region: string;
    shapes: string[];
    completeLater: boolean;
  }): Promise<HaPlanResponseDto> {
    const { answer, dataZones, measured } = await this.answer({
      ...query,
      workerCount: 0,
    });
    const layoutAvailable = dataZones.length > 0;
    if ('refusal' in answer) {
      return {
        layoutAvailable,
        possible: false,
        refusal: answer.refusal,
        completeLaterHelps: answer.completeLaterHelps === true,
        region: null,
        measured,
        servers: [],
        later: [],
      };
    }
    const role = (zone: string) =>
      dataZones.includes(zone) ? ('data' as const) : ('vote' as const);
    return {
      layoutAvailable,
      possible: true,
      refusal: null,
      completeLaterHelps: false,
      region: answer.plan.region,
      measured,
      servers: [
        {
          ...answer.plan.first,
          role: role(answer.plan.first.zone),
          first: true,
        },
        ...answer.plan.servers.map((s) => ({
          ...s,
          role: role(s.zone),
          first: false,
        })),
      ],
      later: answer.plan.later,
    };
  }

  private async answer(input: {
    provider: CloudProvider;
    region: string;
    shapes: string[];
    completeLater: boolean;
    workerCount: number;
  }): Promise<{
    answer: HaCreationAnswer;
    dataZones: string[];
    measured: boolean;
  }> {
    const capabilities = this.capabilitiesFactory.getCapabilitiesService(
      input.provider,
    );
    const where = capabilities.nodeTopology(input.region);
    const region = where?.region;
    const resolution = resolveHaTopology(
      capabilities.haTopologies(),
      region,
      [],
    );
    const catalogue = (await this.providers
      ?.getProvider(input.provider)
      .getNodeSizes?.(true)) as CatalogueShape[] | undefined;
    const shapes = await Promise.all(
      input.shapes.map((s) => shapeNameVia(this.providers, input.provider, s)),
    );
    const answer = planHaCreation({
      topology: resolution.topology,
      unsupported: unsupportedReason(region, resolution),
      firstZone: where?.zone ?? input.region,
      workerCount: input.workerCount,
      shapes,
      catalogue: catalogue ?? [],
      completeLater: input.completeLater,
    });
    return {
      answer,
      dataZones: resolution.topology?.dataZones ?? [],
      measured: resolution.topology?.measured ?? true,
    };
  }
}

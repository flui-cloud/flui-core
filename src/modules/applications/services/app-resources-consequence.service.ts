import { BadRequestException, Injectable } from '@nestjs/common';
import { ScalingEngineService } from '../../infrastructure/scaling/engine/scaling-engine.service';
import {
  ResourceQuantityError,
  cpuMillicoresOf,
  limitBelowRequest,
  memoryMiOf,
  normalizeResourcePair,
} from '../../shared/utils/resource-quantity.util';
import {
  ContainerRuntimeDetailDto,
  ResourcesConsequenceDto,
  UpdateResourcesDto,
} from '../dto/app-management.dto';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppManagementService } from './app-management.service';

@Injectable()
export class AppResourcesConsequenceService {
  constructor(
    private readonly applications: ApplicationsRepository,
    private readonly management: AppManagementService,
    private readonly engine: ScalingEngineService,
  ) {}

  async consequenceOf(
    appId: string,
    dto: UpdateResourcesDto,
  ): Promise<ResourcesConsequenceDto> {
    const runtime = await this.management.getRuntimeStatus(appId);
    const app = await this.applications.findById(appId);
    const containers = runtime.containers;
    const target =
      containers.find((c) => c.name === dto.containerName) ?? containers[0];
    const written = normalized(dto);
    const requests = {
      cpu: written.requests?.cpu ?? target?.requests.cpu ?? null,
      memory: written.requests?.memory ?? target?.requests.memory ?? null,
    };
    const limits = {
      cpu: written.limits?.cpu ?? target?.limits.cpu ?? null,
      memory: written.limits?.memory ?? target?.limits.memory ?? null,
    };
    const problem = safely(() =>
      limitBelowRequest({
        requests: present(requests),
        limits: present(limits),
      }),
    );

    const pod = containers
      .filter((c) => c !== target)
      .reduce(
        (sum, c) => ({
          cpu: sum.cpu + quantityOr(cpuMillicoresOf, c.requests.cpu),
          memory: sum.memory + quantityOr(memoryMiOf, c.requests.memory),
        }),
        {
          cpu: quantityOr(cpuMillicoresOf, requests.cpu),
          memory: quantityOr(memoryMiOf, requests.memory),
        },
      );

    const placement = await this.engine.whatIf(
      app.clusterId,
      {
        cpuMillicores: pod.cpu,
        memoryMi: pod.memory,
        replicas: Math.max(1, runtime.replicas.desired ?? app.replicas ?? 1),
      },
      (item) =>
        item.metadata?.namespace === app.k8sNamespace &&
        item.metadata?.labels?.['flui-app-id'] === app.id,
    );

    return { requests, limits, problem, placement };
  }
}

function normalized(dto: UpdateResourcesDto): UpdateResourcesDto {
  try {
    return normalizeResourcePair(dto);
  } catch (err) {
    if (err instanceof ResourceQuantityError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}

function present(values: { cpu: string | null; memory: string | null }) {
  return {
    ...(values.cpu && { cpu: values.cpu }),
    ...(values.memory && { memory: values.memory }),
  };
}

function safely(check: () => string | null): string | null {
  try {
    return check();
  } catch {
    return null;
  }
}

function quantityOr(
  parse: (value: string) => number,
  value: ContainerRuntimeDetailDto['requests']['cpu'],
): number {
  if (!value) return 0;
  try {
    return parse(value);
  } catch {
    return 0;
  }
}

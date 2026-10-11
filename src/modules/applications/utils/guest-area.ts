import { Repository } from 'typeorm';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../../sandbox/entities/sandbox-tenant.entity';
import { SandboxQuota } from '../../sandbox/constants/sandbox-quota.manifest';
import {
  parseCpuMillis,
  parseMemoryMi,
} from '../../infrastructure/clusters/utils/rebuild-scope.util';
import type { ApplicationEntity } from '../entities/application.entity';

/**
 * Why a guest's application may not be deployed where it is, or null.
 *
 * A guest's applications live in the area the guest holds now and nowhere else:
 * the area is where its fences (pod security, quota, isolation) are. A guest
 * keeps the rows of areas that expired, so only the claimed one counts.
 */
export async function claimedAreaOf(
  app: { userId?: string | null },
  tenants: Pick<Repository<SandboxTenantEntity>, 'findOne'>,
): Promise<SandboxTenantEntity | null> {
  if (!app.userId) return null;
  return tenants.findOne({
    where: { userId: app.userId, state: SandboxTenantState.CLAIMED },
  });
}

export function areaRefusal(
  app: { k8sNamespace?: string | null },
  area: SandboxTenantEntity | null,
): string | null {
  if (!area || area.namespace === app.k8sNamespace) return null;
  return `A demo guest's application runs only in its own area, not in ${app.k8sNamespace}`;
}

export async function guestAreaRefusal(
  app: { userId?: string | null; k8sNamespace?: string | null },
  tenants: Pick<Repository<SandboxTenantEntity>, 'findOne'>,
): Promise<string | null> {
  return areaRefusal(app, await claimedAreaOf(app, tenants));
}

const capped = (
  value: string | undefined,
  max: string,
  parse: (v?: string) => number,
): string | undefined => {
  const limit = parse(max);
  const asked = parse(value);
  return value && limit && asked > limit ? max : value;
};

/**
 * The application as an area can run it: no container may ask for more than
 * the area's per-container ceiling, or the cluster refuses the pod outright. A
 * catalogue entry written for a whole machine (Postgres asks for 2 CPU) then
 * runs within the area instead of failing; a request never ends above its limit.
 */
export function fitToArea<T extends Pick<ApplicationEntity, 'resources'>>(
  app: T,
  quota: Pick<SandboxQuota, 'maxContainerCpu' | 'maxContainerMemory'>,
): T {
  const cpu = app.resources?.cpu;
  const memory = app.resources?.memory;
  const cpuLimit = capped(cpu?.limit, quota.maxContainerCpu, parseCpuMillis);
  const memoryLimit = capped(
    memory?.limit,
    quota.maxContainerMemory,
    parseMemoryMi,
  );
  const cpuRequest = capped(
    capped(cpu?.request, quota.maxContainerCpu, parseCpuMillis),
    cpuLimit ?? quota.maxContainerCpu,
    parseCpuMillis,
  );
  const memoryRequest = capped(
    capped(memory?.request, quota.maxContainerMemory, parseMemoryMi),
    memoryLimit ?? quota.maxContainerMemory,
    parseMemoryMi,
  );
  if (
    cpuLimit === cpu?.limit &&
    memoryLimit === memory?.limit &&
    cpuRequest === cpu?.request &&
    memoryRequest === memory?.request
  ) {
    return app;
  }
  return {
    ...app,
    resources: {
      ...app.resources,
      cpu: { ...cpu, request: cpuRequest, limit: cpuLimit },
      memory: { ...memory, request: memoryRequest, limit: memoryLimit },
    },
  };
}

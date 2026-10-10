import {
  parseCpuMillicores,
  parseMemoryMB,
} from '../../topology/services/topology-k8s.helper';
import { ApplicationResources } from '../interfaces/source-config.interface';

export const PLATFORM_API = { namespace: 'flui-system', name: 'flui-api' };

export const maxApiReplicas = () =>
  Number(process.env.FLUI_API_MAX_REPLICAS) || 6;

export const isPlatformApi = (app: { slug: string; k8sNamespace: string }) =>
  app.slug === PLATFORM_API.name && app.k8sNamespace === PLATFORM_API.namespace;

/** Why a replica count cannot be set on a system application, or null when it can. */
export function systemReplicasRefusal(
  app: { slug: string; k8sNamespace: string; systemProtected?: boolean },
  replicas: number,
): string | null {
  if (!app.systemProtected) return null;
  if (!Number.isInteger(replicas) || replicas < 1)
    return `${app.slug} is part of the platform and needs at least one copy running`;
  if (isPlatformApi(app) && replicas > maxApiReplicas())
    return `${replicas} copies of the API is over the ${maxApiReplicas()} this installation allows (FLUI_API_MAX_REPLICAS)`;
  return null;
}

export interface LiveApiDeployment {
  replicas: number;
  requests: { cpu?: string; memory?: string };
  limits: { cpu?: string; memory?: string };
}

export interface ApiSizingPlan {
  replicas: number | null;
  resources: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  } | null;
  refused: string | null;
}

const sameCpu = (a?: string, b?: string) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    parseCpuMillicores(a) === parseCpuMillicores(b));
const sameMemory = (a?: string, b?: string) =>
  a === b ||
  (a !== undefined && b !== undefined && parseMemoryMB(a) === parseMemoryMB(b));

/**
 * What to change on the API's Deployment so it matches what this installation
 * chose: the replicas on its application, and only the resources it set.
 * Quantities are compared by value, so `1` and `1000m` never cause a patch,
 * and a patch that would roll the API without changing anything never happens.
 */
export function planApiSizing(
  wanted: {
    replicas: number;
    resources?: ApplicationResources | null;
    autoscaled?: boolean;
  },
  live: LiveApiDeployment,
  maxReplicas: number,
): ApiSizingPlan {
  if (
    !wanted.autoscaled &&
    (!Number.isInteger(wanted.replicas) || wanted.replicas < 1)
  ) {
    return {
      replicas: null,
      resources: null,
      refused: `${wanted.replicas} copies would leave no API to bring itself back`,
    };
  }
  if (!wanted.autoscaled && wanted.replicas > maxReplicas) {
    return {
      replicas: null,
      resources: null,
      refused: `${wanted.replicas} copies is over the ${maxReplicas} this installation allows (FLUI_API_MAX_REPLICAS)`,
    };
  }

  return {
    replicas:
      wanted.autoscaled || wanted.replicas === live.replicas
        ? null
        : wanted.replicas,
    resources: resourcePatch(wanted.resources ?? {}, live),
    refused: null,
  };
}

/** The requests and limits the installation set that the Deployment does not already carry. */
function resourcePatch(
  r: ApplicationResources,
  live: LiveApiDeployment,
): ApiSizingPlan['resources'] {
  const requests: Record<string, string> = {};
  const limits: Record<string, string> = {};
  const differs = (
    wanted: string | undefined,
    current: string | undefined,
    same: (a?: string, b?: string) => boolean,
  ) => !!wanted && !same(wanted, current);
  if (differs(r.cpu?.request, live.requests.cpu, sameCpu))
    requests.cpu = r.cpu!.request!;
  if (differs(r.memory?.request, live.requests.memory, sameMemory))
    requests.memory = r.memory!.request!;
  if (differs(r.cpu?.limit, live.limits.cpu, sameCpu))
    limits.cpu = r.cpu!.limit!;
  if (differs(r.memory?.limit, live.limits.memory, sameMemory))
    limits.memory = r.memory!.limit!;
  const patch = {
    ...(Object.keys(requests).length ? { requests } : {}),
    ...(Object.keys(limits).length ? { limits } : {}),
  };
  return Object.keys(patch).length ? patch : null;
}

import { findSystemAppByLabel } from '../../applications/constants/system-app-catalog';
import { PLATFORM_UPDATE_COMPONENTS } from '../constants/platform-update-components';
import { K3sUpgradePlan } from '../interfaces/k3s-upgrade.interface';
import { bareRepository, splitImageRef } from './declared-image.util';
import { SystemDeployment } from './system-port.util';

export interface UpgradeCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export const API_CHECK = 'API running the target image';

/** Where the API's Deployment lives on the control cluster. */
export function apiDeploymentRef(): { namespace: string; name: string } {
  const def = PLATFORM_UPDATE_COMPONENTS.find((d) => d.key === 'fluiApi');
  const app = def ? findSystemAppByLabel(def.systemAppLabel) : undefined;
  return {
    namespace: app?.k8sNamespace ?? 'flui-system',
    name: def?.systemAppLabel ?? 'flui-api',
  };
}

export function systemNamespaces(control: boolean): string[] {
  const namespaces = new Set(['kube-system']);
  if (control) {
    for (const def of PLATFORM_UPDATE_COMPONENTS) {
      const ns = findSystemAppByLabel(def.systemAppLabel)?.k8sNamespace;
      if (ns) namespaces.add(ns);
    }
  }
  return [...namespaces];
}

export function sameImage(a: string, b: string): boolean {
  const x = splitImageRef(a);
  const y = splitImageRef(b);
  return (
    !!x &&
    !!y &&
    x.tag === y.tag &&
    bareRepository(x.repository) === bareRepository(y.repository)
  );
}

function nodesDetail(
  notReady: Array<{ name: string }>,
  atTarget: boolean,
  k3sVersion: string | null | undefined,
): string | undefined {
  if (notReady.length) {
    return `not Ready: ${notReady.map((n) => n.name).join(', ')}`;
  }
  return atTarget ? undefined : `not all on ${k3sVersion}`;
}

export function nodesCheck(
  clusterName: string,
  plan: Pick<K3sUpgradePlan, 'nodes' | 'upToDate'> | undefined,
  k3sVersion: string | null | undefined,
): UpgradeCheck {
  const notReady = (plan?.nodes ?? []).filter((n) => !n.ready);
  const atTarget = k3sVersion ? !!plan?.upToDate : true;
  return {
    name: `Nodes of ${clusterName}`,
    ok: notReady.length === 0 && atTarget,
    detail: nodesDetail(notReady, atTarget, k3sVersion),
  };
}

const qualifiedName = (d: { namespace: string; name: string }): string =>
  `${d.namespace}/${d.name}`;

export function deploymentChecks(
  clusterName: string,
  deployments: SystemDeployment[],
): UpgradeCheck[] {
  const traefik = deployments.find(
    (d) => d.namespace === 'kube-system' && d.name === 'traefik',
  );
  const down = deployments.filter((d) => !d.available && d.name !== 'traefik');
  return [
    {
      name: `Traefik on ${clusterName}`,
      ok: !!traefik?.available,
      detail: traefik ? undefined : 'not found',
    },
    {
      name: `System components on ${clusterName}`,
      ok: down.length === 0,
      detail: down.length
        ? `not available: ${down.map(qualifiedName).join(', ')}`
        : undefined,
    },
  ];
}

function apiImageDetail(
  ref: { namespace: string; name: string },
  deployment: { images: string[]; available: boolean } | null,
  running: boolean,
): string | undefined {
  if (!deployment) return `${qualifiedName(ref)} not found`;
  if (!running) return `runs ${deployment.images.join(', ')}`;
  return deployment.available ? undefined : 'not available';
}

export function apiImageCheck(
  ref: { namespace: string; name: string },
  deployment: { images: string[]; available: boolean } | null,
  imageRef: string,
): UpgradeCheck {
  const running = deployment?.images.some((i) => sameImage(i, imageRef));
  return {
    name: API_CHECK,
    ok: !!running && !!deployment?.available,
    detail: apiImageDetail(ref, deployment, !!running),
  };
}

function checkLabel(c: UpgradeCheck): string {
  const detail = c.detail ? ` (${c.detail})` : '';
  return `${c.name}${detail}`;
}

export function failingChecksMessage(failing: UpgradeCheck[]): string {
  return `Checks that did not pass: ${failing.map(checkLabel).join('; ')}.`;
}

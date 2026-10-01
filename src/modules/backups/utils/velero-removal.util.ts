import { Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  MANAGED_BY,
  MANAGED_BY_FLUI,
  VELERO_CLUSTER_ROLE_BINDING,
  VELERO_KINDS,
  VELERO_NAMESPACE,
  veleroDefinitionName,
} from './velero-footprint.util';

const NAMESPACE_GONE_TIMEOUT_MS = 3 * 60 * 1000;

export async function removeIfPresent(
  k8s: KubernetesService,
  kubeconfig: string,
  ref: { apiVersion: string; kind: string; name: string },
  namespace: string | undefined,
): Promise<boolean> {
  const found = await k8s.readObject(
    kubeconfig,
    ref.apiVersion,
    ref.kind,
    ref.name,
    namespace,
  );
  if (!found) return false;
  await k8s.deleteObject(
    kubeconfig,
    ref.apiVersion,
    ref.kind,
    ref.name,
    namespace,
  );
  return true;
}

/** The binding is cluster-wide and named generically: only Flui's own goes. */
export async function removeOwnVeleroBinding(
  k8s: KubernetesService,
  kubeconfig: string,
): Promise<boolean> {
  const found = await k8s.readObject(
    kubeconfig,
    VELERO_CLUSTER_ROLE_BINDING.apiVersion,
    VELERO_CLUSTER_ROLE_BINDING.kind,
    VELERO_CLUSTER_ROLE_BINDING.name,
  );
  if (found?.metadata?.labels?.[MANAGED_BY] !== MANAGED_BY_FLUI) return false;
  await k8s.deleteObject(
    kubeconfig,
    VELERO_CLUSTER_ROLE_BINDING.apiVersion,
    VELERO_CLUSTER_ROLE_BINDING.kind,
    VELERO_CLUSTER_ROLE_BINDING.name,
  );
  return true;
}

export async function removeVeleroDefinitions(
  k8s: KubernetesService,
  kubeconfig: string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const k of VELERO_KINDS) {
    if (
      await removeIfPresent(
        k8s,
        kubeconfig,
        {
          apiVersion: 'apiextensions.k8s.io/v1',
          kind: 'CustomResourceDefinition',
          name: veleroDefinitionName(k.plural),
        },
        undefined,
      )
    ) {
      removed.push(
        `CustomResourceDefinition/${veleroDefinitionName(k.plural)}`,
      );
    }
  }
  return removed;
}

/**
 * Finalizers are cleared first because their controller is already gone:
 * an object waiting for it would hold its namespace in Terminating forever.
 * Deleting a Backup object here never touches the data in the bucket.
 */
export async function releaseVeleroObjects(
  k8s: KubernetesService,
  kubeconfig: string,
  logger: Logger,
): Promise<number> {
  let released = 0;
  for (const k of VELERO_KINDS) {
    const items = await k8s.listCrdResources(
      kubeconfig,
      k.kind,
      VELERO_NAMESPACE,
      k.apiVersion,
    );
    for (const item of items) {
      const name = item?.metadata?.name as string | undefined;
      if (!name) continue;
      if ((item?.metadata?.finalizers ?? []).length > 0) {
        await k8s
          .mergePatchObject(kubeconfig, {
            apiVersion: k.apiVersion,
            kind: k.kind,
            metadata: {
              name,
              namespace: VELERO_NAMESPACE,
              finalizers: null,
            },
          })
          .catch((err: any) =>
            logger.warn(
              `[velero-uninstall] ${k.kind}/${name}: finalizers not cleared: ${err?.message}`,
            ),
          );
      }
      await k8s.deleteObject(
        kubeconfig,
        k.apiVersion,
        k.kind,
        name,
        VELERO_NAMESPACE,
      );
      released++;
    }
  }
  return released;
}

export async function waitForVeleroNamespaceGone(
  k8s: KubernetesService,
  kubeconfig: string,
): Promise<void> {
  const deadline = Date.now() + NAMESPACE_GONE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ns = await k8s.readObject(
      kubeconfig,
      'v1',
      'Namespace',
      VELERO_NAMESPACE,
    );
    if (!ns) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(
    `The "${VELERO_NAMESPACE}" namespace is still being deleted after ${NAMESPACE_GONE_TIMEOUT_MS / 60_000} minutes. Run the removal again to continue.`,
  );
}

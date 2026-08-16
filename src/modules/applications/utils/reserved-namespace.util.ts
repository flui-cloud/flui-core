import { BadRequestException } from '@nestjs/common';

export const RESERVED_NAMESPACE_ERROR_CODE = 'RESERVED_NAMESPACE';
export const INVALID_NAMESPACE_ERROR_CODE = 'INVALID_NAMESPACE';

/**
 * Namespaces owned by Kubernetes itself or by the Flui platform. A workload
 * placed in one of these can mount the platform's own Secrets, which turns an
 * ordinary "create application" call into control-plane access.
 *
 * Verified against what actually gets created on a cluster:
 *   - `kube-*`        Kubernetes built-ins (kube-system, kube-public, kube-node-lease)
 *   - `flui-*`        bootstrap manifests (flui-system, flui-control, flui-local-storage,
 *                     flui-monitoring) and code constants (flui-build, flui-observability)
 *   - `build-agents`  bootstrap-scripts/manifests/control/01-namespace.yaml
 *   - `cert-manager`  installed by scripts/k3s-master-init.sh
 *   - `velero`        VELERO_NAMESPACE, created by the Velero installer
 */
export const RESERVED_NAMESPACE_PREFIXES: readonly string[] = [
  'kube-',
  'flui-',
];

export const RESERVED_NAMESPACES: readonly string[] = [
  'build-agents',
  'cert-manager',
  'velero',
];

/** RFC 1123 label: what the Kubernetes API accepts as a namespace name. */
const NAMESPACE_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const NAMESPACE_MAX_LENGTH = 63;

export function isReservedNamespace(namespace: string): boolean {
  const ns = namespace.trim().toLowerCase();
  return (
    RESERVED_NAMESPACES.includes(ns) ||
    RESERVED_NAMESPACE_PREFIXES.some((prefix) => ns.startsWith(prefix))
  );
}

export function isValidNamespaceName(namespace: string): boolean {
  return (
    namespace.length > 0 &&
    namespace.length <= NAMESPACE_MAX_LENGTH &&
    NAMESPACE_PATTERN.test(namespace)
  );
}

/**
 * Single gate for every namespace a client is allowed to name. Rejects both
 * malformed names (which would only fail later, at apply time, with a row
 * already persisted) and platform-owned ones.
 */
export function assertPlaceableNamespace(namespace: string): void {
  if (!isValidNamespaceName(namespace)) {
    throw new BadRequestException({
      statusCode: 400,
      code: INVALID_NAMESPACE_ERROR_CODE,
      message:
        `"${namespace}" is not a valid Kubernetes namespace name. ` +
        `Use lowercase alphanumeric characters or "-", start and end with an alphanumeric character, ` +
        `max ${NAMESPACE_MAX_LENGTH} characters.`,
      namespace,
    });
  }

  if (isReservedNamespace(namespace)) {
    throw new BadRequestException({
      statusCode: 400,
      code: RESERVED_NAMESPACE_ERROR_CODE,
      message:
        `Namespace "${namespace}" is reserved by the platform and cannot host applications. ` +
        `Reserved: ${RESERVED_NAMESPACES.join(', ')}, and anything starting with ${RESERVED_NAMESPACE_PREFIXES.map(
          (p) => `"${p}"`,
        ).join(' or ')}. ` +
        `Omit k8sNamespace to deploy into your own namespace.`,
      namespace,
      reservedNamespaces: RESERVED_NAMESPACES,
      reservedPrefixes: RESERVED_NAMESPACE_PREFIXES,
    });
  }
}

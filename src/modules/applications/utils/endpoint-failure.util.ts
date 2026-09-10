/**
 * Why an `exposure: public` application has no endpoint, kept on the
 * application row.
 *
 * The reconciler recomputes an application's status from its Kubernetes
 * resources, and the pods of a public application nobody can reach are
 * perfectly healthy — so a status written once by the deploy would be back to
 * `running` at the first refresh, and the application would again read as
 * green while the outside world gets a 404. This marker is the fact that
 * survives: the deploy writes it, the reconciler honours it, and whoever
 * creates the missing endpoint clears it.
 */
export const ENDPOINT_FAILURE_METADATA_KEY = 'flui.endpoint.error';

type Metadata = Record<string, any> | null | undefined;

export function readEndpointFailure(metadata: Metadata): string | null {
  const raw = metadata?.[ENDPOINT_FAILURE_METADATA_KEY];
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

export function withEndpointFailure(
  metadata: Metadata,
  reason: string,
): Record<string, any> {
  return { ...metadata, [ENDPOINT_FAILURE_METADATA_KEY]: reason };
}

export function withoutEndpointFailure(
  metadata: Metadata,
): Record<string, any> {
  const rest = { ...metadata };
  delete rest[ENDPOINT_FAILURE_METADATA_KEY];
  return rest;
}

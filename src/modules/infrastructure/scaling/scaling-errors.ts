import { ConflictException, NotFoundException } from '@nestjs/common';

/**
 * The machine-readable half of a refusal on this surface.
 *
 * `HttpExceptionFilter` carries a string `code` out of an exception body and
 * drops everything else, which is the convention the rest of the tree already
 * writes to (`SANDBOX_FULL`, `VNET_REQUIRED`, `CROSS_PROVIDER_NOT_ALLOWED`).
 *
 * It exists here because 404 is three different answers: a route this build
 * does not serve, a cluster that is not there, and a group that is not there.
 * Nest answers the first itself, with no `code` at all — so an absent code on a
 * 404 is what tells a caller it reached an installation without this surface,
 * and it no longer has to read the prose to find out.
 */
export const SCALING_ERROR = {
  CLUSTER_NOT_FOUND: 'CLUSTER_NOT_FOUND',
  GROUP_NOT_FOUND: 'SCALING_GROUP_NOT_FOUND',
  GROUP_NAME_TAKEN: 'SCALING_GROUP_NAME_TAKEN',
} as const;

export function clusterNotFound(clusterId: string): NotFoundException {
  return new NotFoundException({
    code: SCALING_ERROR.CLUSTER_NOT_FOUND,
    message: `Cluster ${clusterId} not found`,
  });
}

export function groupNotFound(id: string): NotFoundException {
  return new NotFoundException({
    code: SCALING_ERROR.GROUP_NOT_FOUND,
    message: `Scaling group ${id} not found`,
  });
}

export function groupNameTaken(
  clusterId: string,
  name: string,
): ConflictException {
  return new ConflictException({
    code: SCALING_ERROR.GROUP_NAME_TAKEN,
    message: `Cluster ${clusterId} already has a scaling group named "${name}"`,
  });
}

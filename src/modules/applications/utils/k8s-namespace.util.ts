import { InternalServerErrorException } from '@nestjs/common';

/**
 * Every application runs in the namespace of its project: `p-<project slug>`.
 * The slug never changes after the project is created (only its name does), so
 * the namespace is as stable as the project. A person is never a namespace:
 * two people of one team share one, and one person's apps follow the projects
 * they belong to.
 */
export const PROJECT_NAMESPACE_PREFIX = 'p-';

export function projectNamespace(projectSlug: string): string {
  return `${PROJECT_NAMESPACE_PREFIX}${projectSlug}`;
}

export const NAMESPACE_OWNER_UNKNOWN_ERROR_CODE = 'NAMESPACE_OWNER_UNKNOWN';

/**
 * Raised when an application must land in its creator's personal project and
 * the caller carries no user. There is no fallback on purpose: `default` is a
 * namespace no project owns, so an application quietly placed there escapes
 * every quota, network policy and sweep bound to a project's namespace. A
 * missing user is a caller that dropped it on the way down, a server defect.
 */
export function ownerUnknown(): InternalServerErrorException {
  return new InternalServerErrorException({
    statusCode: 500,
    code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE,
    message:
      'Cannot place an application: the caller carries no user, so its ' +
      'personal project cannot be found. This is a wiring defect in the ' +
      'creating code path, not something the request can fix.',
  });
}

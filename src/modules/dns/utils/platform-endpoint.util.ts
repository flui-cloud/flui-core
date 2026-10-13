import { Repository } from 'typeorm';
import { AppEndpointEntity } from '../entities/app-endpoint.entity';
import { HostnameMode } from '../enums/hostname-mode.enum';

/**
 * The address a platform application is known by: its domain endpoint when it
 * has one, the install address (IP mode) only while it has none. The install
 * address stays next to the domain one as the way back in.
 */
export function pickPlatformEndpoint<
  T extends Pick<AppEndpointEntity, 'hostnameMode'>,
>(endpoints: T[]): T | null {
  return (
    endpoints.find((e) => e.hostnameMode === HostnameMode.DOMAIN) ??
    endpoints[0] ??
    null
  );
}

export async function findPlatformEndpoint(
  repository: Repository<AppEndpointEntity>,
  applicationId: string,
): Promise<AppEndpointEntity | null> {
  const endpoints = await repository.find({
    where: { applicationId },
    order: { createdAt: 'DESC' },
  });
  return pickPlatformEndpoint(endpoints);
}

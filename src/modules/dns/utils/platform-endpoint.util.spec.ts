jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { HostnameMode } from '../enums/hostname-mode.enum';
import { ApiDomainSyncService } from '../services/api-domain-sync.service';
import { AuthDomainSyncService } from '../services/auth-domain-sync.service';
import { WebDomainSyncService } from '../services/web-domain-sync.service';
import {
  findPlatformEndpoint,
  pickPlatformEndpoint,
} from './platform-endpoint.util';

const INSTALL = {
  id: 'ep-ip',
  applicationId: 'app-web',
  fqdn: 'flui-web.203-0-113-10.nip.io',
  hostnameMode: HostnameMode.IP,
};
const DOMAIN = {
  id: 'ep-domain',
  applicationId: 'app-web',
  fqdn: 'dashboard.flui.cloud',
  hostnameMode: HostnameMode.DOMAIN,
};

function repository(rows: Array<typeof INSTALL>) {
  return {
    find: jest.fn(async ({ where }) =>
      rows.filter((r) => r.applicationId === where.applicationId),
    ),
  };
}

describe('platform endpoint choice', () => {
  it('prefers the domain endpoint over the install address, whatever the order', () => {
    expect(pickPlatformEndpoint([INSTALL, DOMAIN])).toBe(DOMAIN);
    expect(pickPlatformEndpoint([DOMAIN, INSTALL])).toBe(DOMAIN);
  });

  it('uses the install address while there is no domain endpoint', () => {
    expect(pickPlatformEndpoint([INSTALL])).toBe(INSTALL);
    expect(pickPlatformEndpoint([])).toBeNull();
  });

  it('reads the endpoints newest first', async () => {
    const repo = repository([INSTALL, DOMAIN]);
    await expect(findPlatformEndpoint(repo as never, 'app-web')).resolves.toBe(
      DOMAIN,
    );
    expect(repo.find).toHaveBeenCalledWith({
      where: { applicationId: 'app-web' },
      order: { createdAt: 'DESC' },
    });
  });

  describe('domain sync on a fresh installation exposed under a domain', () => {
    const repo = () => repository([INSTALL, DOMAIN]);

    it('the dashboard configuration follows the domain address', async () => {
      const service = new WebDomainSyncService(
        {} as never,
        repo() as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(service['resolveFqdn']('app-web', 'flui-web')).resolves.toBe(
        'dashboard.flui.cloud',
      );
    });

    it('the API configuration follows the domain address', async () => {
      const service = new ApiDomainSyncService(
        {} as never,
        repo() as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(service['resolveFqdn']('app-web', 'flui-web')).resolves.toBe(
        'dashboard.flui.cloud',
      );
    });

    it('the sign-in redirect follows the domain address', async () => {
      const service = new AuthDomainSyncService(
        {} as never,
        {} as never,
        repo() as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await expect(service['resolveWebFqdn']('app-web')).resolves.toBe(
        'dashboard.flui.cloud',
      );
    });
  });
});

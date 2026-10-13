jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SYSTEM_HOSTNAME_INVALID,
  SYSTEM_HOSTNAME_TAKEN,
  SystemHostnamesService,
} from './system-hostnames.service';
import { DnsRecordType } from '../../providers/interfaces/dns-provider.interface';

const CLUSTER: {
  id: string;
  name: string;
  masterIpAddress: string | null;
  metadata: Record<string, unknown>;
} = {
  id: 'cluster-1',
  name: 'control',
  masterIpAddress: '203.0.113.10',
  metadata: {},
};
const ZONE = {
  id: 'zone-1',
  zoneName: 'flui.cloud',
  dnsProvider: 'hetzner',
  providerZoneId: 'pz-1',
};
const APPS: Record<string, { id: string; slug: string; name: string }> = {
  'flui-web': { id: 'app-web', slug: 'flui-web', name: 'Flui Web' },
  'flui-api': { id: 'app-api', slug: 'flui-api', name: 'Flui API' },
  zitadel: { id: 'app-auth', slug: 'zitadel', name: 'Zitadel' },
};

interface Opts {
  endpoints?: {
    applicationId: string;
    fqdn: string;
    application?: { name: string };
  }[];
  records?: { name: string; type: DnsRecordType; value: string }[];
  recordsThrow?: boolean;
  served?: Error;
  zitadel?: boolean;
  assignedZone?: typeof ZONE | null;
  wildcard?: boolean;
  registeredZones?: (typeof ZONE)[];
  cluster?: typeof CLUSTER;
}

function build(opts: Opts = {}) {
  const endpoints = opts.endpoints ?? [];
  const listRecords = jest.fn(async () => {
    if (opts.recordsThrow) throw new Error('provider down');
    return (opts.records ?? []).map((r, i) => ({
      recordId: `r${i}`,
      zoneId: ZONE.providerZoneId,
      ttl: 300,
      ...r,
    }));
  });
  const assertClaimable = jest.fn(async () => {
    if (opts.served) throw opts.served;
  });
  const cluster = opts.cluster ?? CLUSTER;
  const assigned = opts.assignedZone === undefined ? ZONE : opts.assignedZone;
  const service = new SystemHostnamesService(
    {
      findOne: jest.fn(async ({ where }) =>
        where.id === cluster.id ? cluster : null,
      ),
    } as never,
    {
      findOne: jest.fn(async ({ where }) => {
        const app = APPS[where.slug];
        return app
          ? { ...app, clusterId: CLUSTER.id, k8sNamespace: 'flui-system' }
          : null;
      }),
    } as never,
    {
      find: jest.fn(async ({ where }) =>
        endpoints.filter((e) =>
          where.fqdn !== undefined
            ? e.fqdn === where.fqdn
            : e.applicationId === where.applicationId,
        ),
      ),
      findOne: jest.fn(
        async ({ where }) =>
          endpoints.find((e) => e.applicationId === where.applicationId) ??
          null,
      ),
    } as never,
    {
      findOne: jest.fn(async ({ where }) =>
        where.id === ZONE.id ? ZONE : null,
      ),
      find: jest.fn(async () => opts.registeredZones ?? [ZONE]),
    } as never,
    {
      getZoneForFqdn: jest.fn(async (_clusterId: string, fqdn: string) =>
        assigned &&
        (fqdn === assigned.zoneName || fqdn.endsWith(`.${assigned.zoneName}`))
          ? { dnsZone: assigned, wildcardCertificate: opts.wildcard ?? true }
          : null,
      ),
      getZoneAssignment: jest.fn(async () =>
        opts.assignedZone === undefined
          ? { dnsZone: ZONE }
          : opts.assignedZone
            ? { dnsZone: opts.assignedZone }
            : null,
      ),
      getSystemDnsStatus: jest.fn(async () => {
        const entry = (app: string) => ({
          applicationId: APPS[app].id,
          domain:
            endpoints.find((e) => e.applicationId === APPS[app].id)?.fqdn ??
            null,
        });
        return {
          fluiApi: entry('flui-api'),
          fluiWeb: entry('flui-web'),
          zitadel: opts.zitadel === false ? null : entry('zitadel'),
        };
      }),
    } as never,
    { assertClaimable } as never,
    { getDnsProvider: jest.fn(() => ({ listRecords })) } as never,
  );
  return { service, listRecords, assertClaimable };
}

async function refusal(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected a refusal');
}

describe('SystemHostnamesService', () => {
  describe('describe', () => {
    it('offers the default names under the primary zone', async () => {
      const { service } = build();
      const result = await service.describe(CLUSTER.id);
      expect(result.zoneName).toBe('flui.cloud');
      expect(
        result.hostnames.map((h) => [h.app, h.label, h.fqdn, h.defaultLabel]),
      ).toEqual([
        ['flui-web', 'dashboard', 'dashboard.flui.cloud', 'dashboard'],
        ['flui-api', 'api', 'api.flui.cloud', 'api'],
        ['zitadel', 'auth', 'auth.flui.cloud', 'auth'],
      ]);
    });

    it('keeps a name already in use under that zone', async () => {
      const { service } = build({
        endpoints: [
          { applicationId: 'app-web', fqdn: 'dashboard-demo.flui.cloud' },
        ],
      });
      const result = await service.describe(CLUSTER.id, ZONE.id);
      expect(result.hostnames[0]).toMatchObject({
        app: 'flui-web',
        label: 'dashboard-demo',
        defaultLabel: 'dashboard',
        currentFqdn: 'dashboard-demo.flui.cloud',
      });
    });

    it('leaves out sign-in when the installation signs in locally', async () => {
      const { service } = build({ zitadel: false });
      const result = await service.describe(CLUSTER.id);
      expect(result.hostnames.map((h) => h.app)).toEqual([
        'flui-web',
        'flui-api',
      ]);
    });

    it('has no addresses while no domain is known', async () => {
      const { service } = build({ assignedZone: null });
      const result = await service.describe(CLUSTER.id);
      expect(result.zoneName).toBeNull();
      expect(result.hostnames[0]).toMatchObject({
        label: 'dashboard',
        fqdn: null,
      });
    });

    it('refuses an unknown zone', async () => {
      const { service } = build();
      await expect(service.describe(CLUSTER.id, 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('check', () => {
    it('turns chosen names into addresses under the zone', async () => {
      const { service, listRecords } = build({
        records: [
          {
            name: 'api',
            type: DnsRecordType.A,
            value: CLUSTER.masterIpAddress,
          },
        ],
      });
      const result = await service.check(CLUSTER.id, {
        dnsZoneId: ZONE.id,
        hostnames: [
          { app: 'flui-web', label: ' Dashboard-Demo ' },
          { app: 'flui-api', label: 'api' },
          { app: 'zitadel', label: 'auth-demo' },
        ],
      });
      expect(result.hostnames.map((h) => h.fqdn)).toEqual([
        'dashboard-demo.flui.cloud',
        'api.flui.cloud',
        'auth-demo.flui.cloud',
      ]);
      expect(listRecords).toHaveBeenCalledWith('pz-1');
    });

    it('refuses a dot under the wildcard certificate and names the field', async () => {
      const { service } = build();
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard.demo' }],
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: SYSTEM_HOSTNAME_INVALID,
        field: 'flui-web',
      });
      expect(err.getResponse().message).toContain('single level');
    });

    it('refuses the same address for two applications', async () => {
      const { service } = build();
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [
            { app: 'flui-web', label: 'demo' },
            { app: 'flui-api', label: 'demo' },
          ],
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ field: 'flui-api' });
    });

    it('refuses both or neither of label and address', async () => {
      const { service } = build();
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'a', fqdn: 'a.example.com' }],
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.check(CLUSTER.id, { hostnames: [{ app: 'flui-web' }] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a name before a domain is known', async () => {
      const { service } = build({ assignedZone: null });
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('answers 409 when another application uses the address', async () => {
      const { service } = build({
        endpoints: [
          {
            applicationId: 'other',
            fqdn: 'dashboard.flui.cloud',
            application: { name: 'Shop' },
          },
        ],
      });
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: SYSTEM_HOSTNAME_TAKEN,
        field: 'flui-web',
        fqdn: 'dashboard.flui.cloud',
        message:
          'dashboard.flui.cloud is already used by Shop. Choose another name.',
      });
    });

    it('lets an application keep the address it already has', async () => {
      const { service, listRecords } = build({
        endpoints: [{ applicationId: 'app-web', fqdn: 'dashboard.flui.cloud' }],
        records: [
          { name: 'dashboard', type: DnsRecordType.A, value: '198.51.100.7' },
        ],
      });
      const result = await service.check(CLUSTER.id, {
        hostnames: [{ app: 'flui-web', label: 'dashboard' }],
      });
      expect(result.hostnames[0].fqdn).toBe('dashboard.flui.cloud');
      expect(listRecords).not.toHaveBeenCalled();
    });

    it('answers 409 when the zone already points the name elsewhere', async () => {
      const { service } = build({
        records: [
          { name: 'dashboard', type: DnsRecordType.A, value: '198.51.100.7' },
        ],
      });
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().message).toBe(
        'dashboard.flui.cloud already points to 198.51.100.7, probably another installation or service. Choose another name.',
      );
    });

    it('does not count a wildcard record or a TXT record as taking the name', async () => {
      const { service } = build({
        records: [
          { name: '*', type: DnsRecordType.A, value: '198.51.100.7' },
          { name: 'dashboard', type: DnsRecordType.TXT, value: 'x' },
        ],
      });
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      ).resolves.toBeDefined();
    });

    it('does not pretend a name is free when the zone cannot be read', async () => {
      const { service } = build({ recordsThrow: true });
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('turns a host served by another namespace into a 409 on the field', async () => {
      const { service } = build({
        served: new ConflictException({
          message: 'Host x is already served by y elsewhere on this cluster.',
        }),
      });
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-api', label: 'api' }],
        }),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: SYSTEM_HOSTNAME_TAKEN,
        field: 'flui-api',
        message: 'Host x is already served by y elsewhere on this cluster.',
      });
    });

    it('accepts full addresses, several levels deep, without reading a zone', async () => {
      const { service, listRecords } = build({ assignedZone: null });
      const result = await service.check(CLUSTER.id, {
        hostnames: [
          { app: 'flui-web', fqdn: 'Dashboard.Demo.example.com' },
          { app: 'flui-api', fqdn: 'api.1-2-3-4.nip.io' },
        ],
      });
      expect(result.hostnames.map((h) => [h.label, h.fqdn])).toEqual([
        [null, 'dashboard.demo.example.com'],
        [null, 'api.1-2-3-4.nip.io'],
      ]);
      expect(listRecords).not.toHaveBeenCalled();
    });

    it('reads the zone covering a full address and refuses a name taken there', async () => {
      const { service, listRecords } = build({
        records: [
          { name: 'console', type: DnsRecordType.A, value: '198.51.100.7' },
        ],
      });
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', fqdn: 'Console.flui.cloud' }],
        }),
      );
      expect(listRecords).toHaveBeenCalledWith('pz-1');
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: SYSTEM_HOSTNAME_TAKEN,
        field: 'flui-web',
        fqdn: 'console.flui.cloud',
      });
    });

    it('checks a full address against a registered zone the cluster does not use', async () => {
      const other = {
        ...ZONE,
        id: 'zone-2',
        zoneName: 'example.org',
        providerZoneId: 'pz-2',
      };
      const { service, listRecords } = build({
        assignedZone: null,
        registeredZones: [ZONE, other],
        records: [
          {
            name: 'deep.api',
            type: DnsRecordType.CNAME,
            value: 'elsewhere.net.',
          },
        ],
      });
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-api', fqdn: 'deep.api.example.org' }],
        }),
      ).rejects.toThrow(ConflictException);
      expect(listRecords).toHaveBeenCalledWith('pz-2');
    });

    it('refuses a full address deeper than the wildcard certificate of its zone', async () => {
      const { service } = build();
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', fqdn: 'dashboard.demo.flui.cloud' }],
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: SYSTEM_HOSTNAME_INVALID,
        field: 'flui-web',
      });
      expect(err.getResponse().message).toContain('single level');
    });

    it('refuses the bare domain under a wildcard certificate', async () => {
      const { service } = build();
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', fqdn: 'flui.cloud' }],
        }),
      );
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse().message).toContain('not flui.cloud itself');
    });

    it('accepts a deep full address when the zone has no wildcard certificate', async () => {
      const { service } = build({ wildcard: false });
      const result = await service.check(CLUSTER.id, {
        hostnames: [{ app: 'flui-web', fqdn: 'dashboard.demo.flui.cloud' }],
      });
      expect(result.hostnames[0].fqdn).toBe('dashboard.demo.flui.cloud');
    });

    it('recognises its own address written differently', async () => {
      const cluster = {
        ...CLUSTER,
        masterIpAddress: null,
        metadata: { ingressAddresses: { addresses: ['2001:db8::10'] } },
      };
      const { service } = build({
        cluster,
        records: [
          {
            name: 'dashboard',
            type: DnsRecordType.AAAA,
            value: '2001:DB8:0:0:0:0:0:10',
          },
        ],
      });
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      ).resolves.toBeDefined();
    });

    it('answers 503 when the name has a record and the cluster address is unknown', async () => {
      const { service } = build({
        cluster: { ...CLUSTER, masterIpAddress: null },
        records: [
          { name: 'dashboard', type: DnsRecordType.A, value: '198.51.100.7' },
        ],
      });
      const err = await refusal(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      );
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getResponse()).toMatchObject({
        code: 'system_hostname_unverified',
        field: 'flui-web',
      });
    });

    it('still calls a free name free when the cluster address is unknown', async () => {
      const { service } = build({
        cluster: { ...CLUSTER, masterIpAddress: null },
      });
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', label: 'dashboard' }],
        }),
      ).resolves.toBeDefined();
    });

    it('refuses an invalid full address', async () => {
      const { service } = build();
      await expect(
        service.check(CLUSTER.id, {
          hostnames: [{ app: 'flui-web', fqdn: 'bad_name.example.com' }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

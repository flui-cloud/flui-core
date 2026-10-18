import {
  AppRecord,
  assignStacks,
  groupKeyOf,
  imageRepository,
  overlayOf,
} from './topology-enrich.util';
import { TopologyAppDto } from '../dto/topology.dto';
import {
  TopologyAppStatus,
  TopologyExposure,
  TopologyOverlay,
  TopologyStackType,
} from '../enums/topology.enums';

const record = (over: Partial<AppRecord>): AppRecord => ({
  id: 'a',
  name: 'api',
  slug: 'api',
  ...over,
});

describe('groupKeyOf', () => {
  it('matches the same repository, folder and name on two clusters', () => {
    const eu = record({
      id: 'eu',
      sourceConfig: {
        gitUrl: 'https://github.com/acme/shop.git',
        subPath: 'api',
      },
    });
    const us = record({
      id: 'us',
      sourceConfig: { gitUrl: 'git@github.com:acme/shop', subPath: 'api' },
    });
    expect(groupKeyOf(eu)).not.toBe(groupKeyOf(record({ id: 'x' })));
    expect(groupKeyOf(eu)).toBe(
      groupKeyOf(
        record({
          id: 'us2',
          sourceConfig: {
            gitUrl: 'https://user:token@GitHub.com/acme/shop/',
            subPath: 'api',
          },
        }),
      ),
    );
    expect(groupKeyOf(us)).toMatch(/^repo:[0-9a-f]{16}$/);
  });

  it('keeps two folders of one repository apart', () => {
    const one = record({
      sourceConfig: { repositoryId: 'r1', subPath: 'api' },
    });
    const two = record({
      sourceConfig: { repositoryId: 'r1', subPath: 'web' },
    });
    expect(groupKeyOf(one)).not.toBe(groupKeyOf(two));
  });

  it('never carries the repository in clear', () => {
    const key = groupKeyOf(
      record({ sourceConfig: { gitUrl: 'https://github.com/acme/shop' } }),
    );
    expect(key).not.toContain('acme');
  });

  it('never shares a catalog component across installs', () => {
    expect(
      groupKeyOf(record({ id: 'p1', metadata: { catalogInstallId: 'i1' } })),
    ).toBe('app:p1');
  });

  it('matches images by repository, whatever the tag', () => {
    const v1 = record({ sourceConfig: { imageRef: 'ghcr.io/acme/api:1.2' } });
    const v2 = record({
      sourceConfig: { imageRef: 'ghcr.io/acme/api@sha256:ab' },
    });
    const other = record({
      sourceConfig: { imageRef: 'ghcr.io/acme/web:1.2' },
    });
    expect(groupKeyOf(v1)).toBe(groupKeyOf(v2));
    expect(groupKeyOf(v1)).not.toBe(groupKeyOf(other));
  });
});

describe('imageRepository', () => {
  it.each([
    ['nginx:1.27', 'nginx'],
    ['registry.local:5000/team/api', 'registry.local:5000/team/api'],
    ['registry.local:5000/team/api:2', 'registry.local:5000/team/api'],
    ['ghcr.io/acme/api@sha256:00', 'ghcr.io/acme/api'],
  ])('%s → %s', (ref, repo) => {
    expect(imageRepository(ref)).toBe(repo);
  });
});

describe('assignStacks', () => {
  const app = (id: string, status = TopologyAppStatus.RUNNING) =>
    ({
      id,
      clusterId: 'c1',
      displayName: id,
      status,
    }) as TopologyAppDto;

  it('groups an install into one composed stack, with the component serving its name as primary', () => {
    const apps = [app('db', TopologyAppStatus.ERROR), app('web'), app('solo')];
    const records = new Map<string, AppRecord>([
      [
        'db',
        record({ id: 'db', slug: 'db', metadata: { catalogInstallId: 'i1' } }),
      ],
      [
        'web',
        record({
          id: 'web',
          slug: 'shop',
          exposure: 'public',
          labels: { 'flui.cloud/catalog-install': 'i1' },
        }),
      ],
      ['solo', record({ id: 'solo', slug: 'solo', exposure: 'internal' })],
    ]);
    const stacks = assignStacks(
      apps,
      records,
      new Map([
        ['i1', { id: 'i1', displayName: 'Shop', resolvedFqdn: 'shop.acme.io' }],
      ]),
    );

    const composed = stacks.find((s) => s.type === TopologyStackType.COMPOSED)!;
    expect(composed).toMatchObject({
      id: 'i1',
      name: 'Shop',
      primaryAppId: 'web',
      appIds: ['db', 'web'],
      status: TopologyAppStatus.ERROR,
    });
    expect(stacks.find((s) => s.id === 'app:solo')).toMatchObject({
      type: TopologyStackType.STANDALONE,
      appIds: ['solo'],
    });
    expect(apps.map((a) => a.stackId)).toEqual(['i1', 'i1', 'app:solo']);
    expect(apps[1].exposure).toBe(TopologyExposure.PUBLIC);
    expect(apps[2].exposure).toBe(TopologyExposure.INTERNAL);
  });

  it('treats an app whose install is gone as standalone', () => {
    const apps = [app('orphan')];
    const stacks = assignStacks(
      apps,
      new Map([
        [
          'orphan',
          record({ id: 'orphan', metadata: { catalogInstallId: 'gone' } }),
        ],
      ]),
      new Map(),
    );
    expect(stacks[0].id).toBe('app:orphan');
  });

  it('names an app as its record does, not as its suffixed workload', () => {
    const apps = [{ ...app('a1'), displayName: 'backend-t58zkt' }];
    const stacks = assignStacks(
      apps,
      new Map([['a1', record({ id: 'a1', name: 'backend' })]]),
      new Map(),
    );
    expect(apps[0].displayName).toBe('backend');
    expect(stacks[0].name).toBe('backend');
  });

  it('shows an app removed in Flui whose workload still runs as a leftover, alone, not in its old install', () => {
    const apps = [app('left')];
    const stacks = assignStacks(
      apps,
      new Map([
        [
          'left',
          record({
            id: 'left',
            name: 'b2b-tools',
            deletedAt: new Date(),
            metadata: { catalogInstallId: 'i1' },
          }),
        ],
      ]),
      new Map([['i1', { id: 'i1', displayName: 'b2b-tools' }]]),
    );
    expect(apps[0]).toMatchObject({
      displayName: 'b2b-tools',
      status: 'warning',
      statusReason: 'Removed in Flui, still running on the cluster',
      stackId: 'app:left',
    });
    expect(stacks.map((s) => s.id)).toEqual(['app:left']);
  });

  it('gives an app with no record a stack and an exposure of its own', () => {
    const apps = [app('unknown')];
    assignStacks(apps, new Map(), new Map());
    expect(apps[0]).toMatchObject({
      stackId: 'app:unknown',
      groupKey: 'app:unknown',
      exposure: TopologyExposure.CLUSTER,
    });
  });
});

describe('overlayOf', () => {
  it.each([
    [
      { networkOn: false, isControl: false, held: false, member: true },
      TopologyOverlay.OFF,
    ],
    [
      { networkOn: true, isControl: true, held: false, member: false },
      TopologyOverlay.TUNNEL,
    ],
    [
      { networkOn: true, isControl: false, held: false, member: true },
      TopologyOverlay.TUNNEL,
    ],
    [
      { networkOn: true, isControl: false, held: true, member: true },
      TopologyOverlay.PUBLIC_ADDRESS,
    ],
    [
      { networkOn: true, isControl: false, held: false, member: false },
      TopologyOverlay.PUBLIC_ADDRESS,
    ],
  ])('%j → %s', (input, expected) => {
    expect(overlayOf(input)).toBe(expected);
  });
});

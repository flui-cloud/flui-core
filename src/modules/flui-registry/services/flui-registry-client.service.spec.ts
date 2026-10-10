import {
  FluiRegistryClientService,
  versionIdOf,
} from './flui-registry-client.service';

const APP = '11111111-1111-4111-8111-111111111111';
const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;

function harness(responses: Record<string, () => Response>) {
  const signed: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const client = new FluiRegistryClientService(
    {
      mode: 'flui',
      host: 'api.example.test',
      internalUrl: 'http://registry.internal:5000',
      realm: null,
      service: 'flui-registry',
      issuer: 'flui-api',
      pushTokenSeconds: 900,
      pullTokenSeconds: 300,
      image: 'zot',
      storage: '1Gi',
      storageBackend: 'filesystem',
      storageClass: null,
      replicas: 1,
      cacheImage: 'redis',
      keepTags: 3,
      appQuotaMb: 0,
      maxRequestMb: 0,
      rateAverage: 0,
      rateBurst: 0,
      ioTimeoutSeconds: 600,
      spaceAlertPercent: 80,
      spaceAlertGib: 50,
    },
    {
      sign: async (claims: Record<string, unknown>) => {
        signed.push(claims);
        return 'signed';
      },
    } as never,
  );
  jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      async (url: string | URL | Request, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${String(url)}`;
        calls.push(key);
        const respond = responses[key];
        return respond ? respond() : new Response(null, { status: 404 });
      },
    );
  return { client, signed, calls };
}

const base = `http://registry.internal:5000/v2/apps/${APP}`;
const digest = (d: string) => () =>
  new Response(null, { status: 200, headers: { 'docker-content-digest': d } });

describe('the API’s calls to the instance registry', () => {
  afterEach(() => jest.restoreAllMocks());

  it('groups tags by the image they point at, with a stable number per image', async () => {
    const { client } = harness({
      [`GET ${base}/tags/list`]: () =>
        Response.json({ tags: ['abc1234', 'latest', 'old1234'] }),
      [`HEAD ${base}/manifests/abc1234`]: digest(D1),
      [`HEAD ${base}/manifests/latest`]: digest(D1),
      [`HEAD ${base}/manifests/old1234`]: digest(D2),
    });

    expect(await client.listVersions(APP)).toEqual([
      { versionId: versionIdOf(D1), digest: D1, tags: ['abc1234', 'latest'] },
      { versionId: versionIdOf(D2), digest: D2, tags: ['old1234'] },
    ]);
    expect(Number.isSafeInteger(versionIdOf(D1))).toBe(true);
  });

  it('signs a token for this one repository and nothing else', async () => {
    const { client, signed } = harness({
      [`DELETE ${base}/manifests/${D1}`]: () =>
        new Response(null, { status: 202 }),
    });
    await client.deleteDigest(APP, D1);

    expect(signed[0].access).toEqual([
      { type: 'repository', name: `apps/${APP}`, actions: ['pull', 'delete'] },
    ]);
    expect(Number(signed[0].exp) - Number(signed[0].iat)).toBe(60);
  });

  it('treats an application with no images yet as having none', async () => {
    const { client } = harness({});
    expect(await client.listVersions(APP)).toEqual([]);
    await expect(client.deleteRepository(APP)).resolves.toBe(0);
  });

  it('removes every image of a deleted application', async () => {
    const { client, calls } = harness({
      [`GET ${base}/tags/list`]: () => Response.json({ tags: ['a', 'b'] }),
      [`HEAD ${base}/manifests/a`]: digest(D1),
      [`HEAD ${base}/manifests/b`]: digest(D2),
      [`DELETE ${base}/manifests/${D1}`]: () =>
        new Response(null, { status: 202 }),
      [`DELETE ${base}/manifests/${D2}`]: () =>
        new Response(null, { status: 202 }),
    });
    await expect(client.deleteRepository(APP)).resolves.toBe(2);
    expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(2);
  });

  it('says so when the registry refuses a deletion', async () => {
    const { client } = harness({
      [`DELETE ${base}/manifests/${D1}`]: () =>
        new Response(null, { status: 401 }),
    });
    await expect(client.deleteDigest(APP, D1)).rejects.toThrow(/HTTP 401/);
  });

  it('measures an application’s images counting each layer once', async () => {
    const IDX = `sha256:${'c'.repeat(64)}`;
    const AMD = `sha256:${'d'.repeat(64)}`;
    const ARM = `sha256:${'e'.repeat(64)}`;
    const blob = (c: string, size: number) => ({
      digest: `sha256:${c.repeat(64)}`,
      size,
    });
    const { client } = harness({
      [`GET ${base}/tags/list`]: () => Response.json({ tags: ['v1', 'v2'] }),
      [`HEAD ${base}/manifests/v1`]: digest(IDX),
      [`HEAD ${base}/manifests/v2`]: digest(D1),
      [`GET ${base}/manifests/${IDX}`]: () =>
        Response.json({ manifests: [{ digest: AMD }, { digest: ARM }] }),
      [`GET ${base}/manifests/${AMD}`]: () =>
        Response.json({
          config: blob('1', 10),
          layers: [blob('2', 100), blob('3', 1000)],
        }),
      [`GET ${base}/manifests/${ARM}`]: () =>
        Response.json({
          config: blob('4', 10),
          layers: [blob('2', 100), blob('5', 1000)],
        }),
      [`GET ${base}/manifests/${D1}`]: () =>
        Response.json({ config: blob('6', 10), layers: [blob('3', 1000)] }),
    });
    await expect(client.repositorySizeBytes(APP)).resolves.toBe(
      10 + 100 + 1000 + 10 + 1000 + 10,
    );
  });
});

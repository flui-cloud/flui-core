import { BadRequestException } from '@nestjs/common';
import { fluiRegistryConfigFrom } from '../flui-registry.config';
import { RegistryTrafficService } from './registry-traffic.service';

const vector = (label: string, values: Record<string, number>) => ({
  data: {
    result: Object.entries(values).map(([k, v]) => ({
      metric: { [label]: k },
      value: [0, String(v)],
    })),
  },
});
const scalar = (v: number) => ({
  data: { result: [{ metric: {}, value: [0, String(v)] }] },
});

const harness = (backend = 's3') => {
  const asked: string[] = [];
  const service = new RegistryTrafficService(
    fluiRegistryConfigFrom(
      (key) =>
        ({
          FLUI_IMAGE_REGISTRY: 'flui',
          FLUI_REGISTRY_STORAGE_BACKEND: backend,
        })[key],
    ),
    {
      queryInstant: async (q: string) => {
        asked.push(q);
        if (q.includes('sum by (method)')) {
          return vector('method', {
            GET: 90.4,
            HEAD: 10,
            PUT: 5,
            PATCH: 3,
            POST: 2,
            DELETE: 1,
          });
        }
        if (q.includes('sum by (code)')) {
          return vector('code', {
            '200': 100,
            '201': 7,
            '401': 40,
            '403': 1,
            '429': 2,
            '413': 1,
            '404': 6,
            '500': 3,
            '502': 1,
          });
        }
        if (q.includes('max_over_time') && q.includes('responses'))
          return scalar(5_000_000.4);
        if (q.includes('max_over_time')) return scalar(2_000_000);
        if (q.includes('responses_bytes')) return scalar(900_000_000);
        return scalar(300_000_000);
      },
    } as never,
  );
  return { service, asked };
};

describe('what the registry carried', () => {
  it('counts pulls, pushes and outcomes, and never a token challenge as a refusal', async () => {
    const { service, asked } = harness();
    const traffic = await service.traffic('7d');
    expect(traffic.requests).toEqual({ pulls: 100, pushes: 10, deletes: 1 });
    expect(traffic.outcomes).toEqual({
      ok: 107,
      refused: 4,
      notFound: 6,
      failed: 4,
    });
    expect(traffic).toMatchObject({
      window: '7d',
      bytesIn: 300_000_000,
      bytesOut: 900_000_000,
      peakBytesPerSecondIn: 2_000_000,
      peakBytesPerSecondOut: 5_000_000,
      readFromBucketBytes: 900_000_000,
    });
    expect(
      asked.every((q) =>
        q.includes('flui-system-flui-registry-.*@kubernetescrd'),
      ),
    ).toBe(true);
    expect(asked.every((q) => !q.includes('[24h]'))).toBe(true);
    expect(asked.filter((q) => q.includes('increase'))).toHaveLength(4);
    expect(
      asked.filter((q) => q.includes('traefik_router_requests_total')),
    ).toHaveLength(2);
    expect(asked.some((q) => /[^_]increase\(/.test(q))).toBe(false);
  });

  it('reads nothing from a bucket when the registry keeps images on a volume', async () => {
    const { service } = harness('filesystem');
    expect((await service.traffic()).readFromBucketBytes).toBeNull();
  });

  it('refuses a window it does not know, rather than querying with it', async () => {
    const { service, asked } = harness();
    await expect(service.traffic('5m) or vector(1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(asked).toEqual([]);
  });
});

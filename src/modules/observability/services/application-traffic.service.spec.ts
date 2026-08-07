import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationTrafficService } from './application-traffic.service';
import { PrometheusQueryService } from './prometheus-query.service';
import { PrometheusQueryResult } from '../interfaces/prometheus-response.interface';

const vector = (results: PrometheusQueryResult[]) => ({
  status: 'success' as const,
  data: { resultType: 'vector' as const, result: results },
});

const sample = (labels: Record<string, string>, value: string) => ({
  metric: labels,
  value: [1784374596, value] as [number, string],
});

describe('ApplicationTrafficService', () => {
  let service: ApplicationTrafficService;
  let queryInstant: jest.Mock;
  let queryRange: jest.Mock;

  beforeEach(async () => {
    queryInstant = jest.fn().mockResolvedValue(vector([]));
    queryRange = jest.fn().mockResolvedValue(vector([]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApplicationTrafficService,
        {
          provide: PrometheusQueryService,
          useValue: { queryInstant, queryRange },
        },
      ],
    }).compile();

    service = module.get(ApplicationTrafficService);
  });

  describe('buildTraefikServiceId', () => {
    it('reconstructs the Traefik service label from the app record', () => {
      expect(
        service.buildTraefikServiceId({
          slug: 'vops-api-c9a2jp',
          namespace: 'default',
          port: 7799,
        }),
      ).toBe('default-vops-api-c9a2jp-svc-7799@kubernetes');
    });

    it('handles namespaces containing dashes', () => {
      expect(
        service.buildTraefikServiceId({
          slug: 'api',
          namespace: 'user-dawit',
          port: 80,
        }),
      ).toBe('user-dawit-api-svc-80@kubernetes');
    });

    it('returns null for TCP applications, which never reach the HTTP router', () => {
      expect(
        service.buildTraefikServiceId({
          slug: 'pg',
          namespace: 'default',
          port: 5432,
          portProtocol: 'tcp',
        }),
      ).toBeNull();
    });

    it('returns null when no port is exposed', () => {
      expect(
        service.buildTraefikServiceId({ slug: 'worker', namespace: 'default' }),
      ).toBeNull();
    });
  });

  describe('getTrafficInstant', () => {
    it('skips querying entirely for a non-routable application', async () => {
      const traffic = await service.getTrafficInstant(
        { slug: 'worker', namespace: 'default' },
        '5m',
      );

      expect(queryInstant).not.toHaveBeenCalled();
      expect(traffic.rate.requests_per_second).toBeNull();
      expect(traffic.by_status_code).toEqual([]);
    });

    it('splits status classes and derives error percentages', async () => {
      queryInstant.mockImplementation((query: string) => {
        if (query.includes('by (code)')) {
          return Promise.resolve(
            vector([
              sample({ code: '200' }, '8'),
              sample({ code: '301' }, '1'),
              sample({ code: '404' }, '0.5'),
              sample({ code: '503' }, '0.5'),
            ]),
          );
        }
        return Promise.resolve(vector([]));
      });

      const traffic = await service.getTrafficInstant(
        { slug: 'api', namespace: 'default', port: 80 },
        '5m',
      );

      expect(traffic.rate.requests_per_second).toBe(10);
      expect(traffic.status.rate_2xx).toBe(8);
      expect(traffic.status.rate_3xx).toBe(1);
      expect(traffic.status.rate_4xx).toBe(0.5);
      expect(traffic.status.rate_5xx).toBe(0.5);
      expect(traffic.status.server_error_percent).toBe(5);
      expect(traffic.status.client_error_percent).toBe(5);
    });

    it('keeps non-HTTP outcome codes out of the error percentages', async () => {
      // Traefik records gRPC status codes and `0` for aborted upgrades on the same
      // counter; counting them as 5xx would invent a server fault that never happened.
      queryInstant.mockImplementation((query: string) => {
        if (query.includes('by (code)')) {
          return Promise.resolve(
            vector([
              sample({ code: '200' }, '9'),
              sample({ code: '0' }, '0.5'),
              sample({ code: '16' }, '0.5'),
            ]),
          );
        }
        return Promise.resolve(vector([]));
      });

      const traffic = await service.getTrafficInstant(
        { slug: 'api', namespace: 'default', port: 80 },
        '5m',
      );

      expect(traffic.status.server_error_percent).toBe(0);
      expect(traffic.status.client_error_percent).toBe(0);
      // still visible in the breakdown, just not classified
      expect(traffic.by_status_code.map((entry) => entry.code)).toEqual(
        expect.arrayContaining(['0', '16']),
      );
    });

    it('flags Traefik default buckets as too coarse for percentiles', async () => {
      queryInstant.mockImplementation((query: string) => {
        if (query.includes('count by (le)')) {
          return Promise.resolve(
            vector([
              sample({ le: '0.1' }, '7'),
              sample({ le: '0.3' }, '7'),
              sample({ le: '1.2' }, '7'),
              sample({ le: '5' }, '7'),
              sample({ le: '+Inf' }, '7'),
            ]),
          );
        }
        return Promise.resolve(vector([]));
      });

      const traffic = await service.getTrafficInstant(
        { slug: 'api', namespace: 'default', port: 80 },
        '5m',
      );

      expect(traffic.latency.bucket_boundaries_seconds).toEqual([
        0.1, 0.3, 1.2, 5,
      ]);
      expect(traffic.latency.estimates_are_coarse).toBe(true);
    });

    it('does not flag a tuned histogram as coarse', async () => {
      queryInstant.mockImplementation((query: string) => {
        if (query.includes('count by (le)')) {
          return Promise.resolve(
            vector(
              [
                '0.005',
                '0.01',
                '0.025',
                '0.05',
                '0.1',
                '0.25',
                '0.5',
                '1',
                '5',
              ].map((le) => sample({ le }, '7')),
            ),
          );
        }
        return Promise.resolve(vector([]));
      });

      const traffic = await service.getTrafficInstant(
        { slug: 'api', namespace: 'default', port: 80 },
        '5m',
      );

      expect(traffic.latency.estimates_are_coarse).toBe(false);
    });

    it('degrades to nulls when Prometheus is unreachable', async () => {
      queryInstant.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const traffic = await service.getTrafficInstant(
        { slug: 'api', namespace: 'default', port: 80 },
        '5m',
      );

      expect(traffic.rate.requests_per_second).toBe(0);
      expect(traffic.status.server_error_percent).toBeNull();
      expect(traffic.latency.p95_seconds).toBeNull();
    });
  });

  describe('getTrafficHistory', () => {
    it('merges the four series onto a single timeline', async () => {
      queryRange.mockImplementation((query: string) => {
        if (query.includes('code=~"5.."')) {
          return Promise.resolve({
            status: 'success' as const,
            data: {
              resultType: 'matrix' as const,
              result: [
                { metric: {}, values: [[100, '0.5'] as [number, string]] },
              ],
            },
          });
        }
        if (query.includes('code=~"4.."')) {
          return Promise.resolve(vector([]));
        }
        return Promise.resolve({
          status: 'success' as const,
          data: {
            resultType: 'matrix' as const,
            result: [
              {
                metric: {},
                values: [
                  [100, '10'] as [number, string],
                  [160, '12'] as [number, string],
                ],
              },
            ],
          },
        });
      });

      const points = await service.getTrafficHistory(
        { slug: 'api', namespace: 'default', port: 80 },
        100,
        160,
        '60s',
        '5m',
      );

      expect(points).toHaveLength(2);
      expect(points[0].timestamp).toBe(new Date(100 * 1000).toISOString());
      expect(points[0].rate_5xx).toBe(0.5);
      expect(points[1].rate_5xx).toBeNull();
      expect(points[1].requests_per_second).toBe(12);
    });

    it('returns no points for a non-routable application', async () => {
      const points = await service.getTrafficHistory(
        { slug: 'worker', namespace: 'default' },
        100,
        160,
        '60s',
        '5m',
      );

      expect(points).toEqual([]);
      expect(queryRange).not.toHaveBeenCalled();
    });
  });
});

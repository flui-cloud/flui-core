jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { LokiQueryService } from '../services/loki-query.service';

/**
 * Values from a query string end up inside a LogQL selector. A value carrying
 * a quote must stay a value: it cannot close the matcher, add another one, or
 * leave the selector for another stream.
 */
describe('LogQL built from caller input', () => {
  const make = () => {
    const service = Object.create(
      LokiQueryService.prototype,
    ) as LokiQueryService;
    const queryLogs = jest.fn(async () => ({
      status: 'success',
      data: { result: [] },
    }));
    const lokiGet = jest.fn(async () => ({ data: { data: { result: [] } } }));
    Object.assign(service, {
      queryLogs,
      lokiGet,
      logger: { debug: jest.fn(), error: jest.fn(), log: jest.fn() },
    });
    return { service, queryLogs, lokiGet };
  };

  const crafted = 'x"} |= "" or {cluster_id=~".+';

  /** Everything after the stream selector, with string literals blanked out. */
  const structure = (logQL: string) =>
    logQL.replace(/"(?:[^"\\]|\\.)*"/g, '""');

  it('keeps a crafted search inside its line filter', async () => {
    const { service, queryLogs } = make();

    await service.getServerLogs('c1', undefined, 10, undefined, crafted);

    const logQL = (queryLogs.mock.calls[0] as unknown[])[0] as string;
    expect(structure(logQL)).toBe('{cluster_id=""} |~ ""');
    expect(logQL).toContain('\\"} |= \\"\\" or {cluster_id=~\\".+');
  });

  it('keeps a crafted server id and component inside their matchers', async () => {
    const { service, queryLogs } = make();

    await service.getServerLogs('c1', crafted, 10, crafted);

    const logQL = (queryLogs.mock.calls[0] as unknown[])[0] as string;
    expect(structure(logQL)).toBe(
      '{cluster_id="",server_id=""} | json | component=""',
    );
  });

  it('keeps crafted application filters inside the selector', async () => {
    const { service, queryLogs } = make();

    await service.getAppLogs('c1', {
      namespace: 'ns',
      container: 'web',
      pod: crafted,
      level: crafted,
      search: crafted,
    } as never);

    const logQL = (queryLogs.mock.calls[0] as unknown[])[0] as string;
    expect(structure(logQL)).toBe(
      '{cluster_id="",namespace="",container="",pod="",level=~""} |~ ""',
    );
  });

  it('keeps a regex search meaning what it meant', async () => {
    const { service, queryLogs } = make();

    await service.getServerLogs('c1', undefined, 10, undefined, 'a\\.b');

    const logQL = (queryLogs.mock.calls[0] as unknown[])[0] as string;
    expect(logQL).toBe('{cluster_id="c1"} |~ "(?i)a\\\\.b"');
  });

  it('refuses a value with a line break', async () => {
    const { service } = make();

    await expect(
      service.getServerLogs('c1', undefined, 10, undefined, 'a\n{x="y"}'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a volume step that is not a duration', async () => {
    const { service } = make();

    await expect(
      service.getAppLogVolume('c1', {
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-01T01:00:00Z',
        step: '5m])) or vector(1',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

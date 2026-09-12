import { InstallLogService } from './install-log.service';

describe('InstallLogService', () => {
  const buildQueryBuilder = (row: { content: string }) => {
    const qb: Record<string, any> = {};
    qb.update = jest.fn().mockReturnValue(qb);
    qb.set = jest.fn((values: Record<string, unknown>) => {
      qb.setValues = values;
      return qb;
    });
    qb.where = jest.fn().mockReturnValue(qb);
    qb.setParameters = jest.fn((params: Record<string, unknown>) => {
      qb.params = params;
      // Emulate the SQL-level `content || :toStore` append the real query runs.
      row.content += (params.toStore as string) ?? '';
      return qb;
    });
    qb.execute = jest.fn().mockResolvedValue(undefined);
    return qb;
  };

  const build = (existing?: { content: string; truncated: boolean }) => {
    const row = existing ? { operationId: 'op-1', ...existing } : undefined;
    const state = { row };
    const qb = buildQueryBuilder(state.row ?? { content: '' });

    const repository = {
      findOne: jest.fn(async () => state.row ?? null),
      create: jest.fn((data: Record<string, unknown>) => ({
        content: '',
        byteOffset: 0,
        truncated: false,
        ...data,
      })),
      save: jest.fn(async (entity: Record<string, unknown>) => {
        state.row = entity as never;
        return entity;
      }),
      createQueryBuilder: jest.fn(() => qb),
    };
    const gateway = { emitLogChunk: jest.fn() };
    const service = new InstallLogService(
      repository as never,
      gateway as never,
    );
    return { service, repository, gateway, state, qb };
  };

  it('creates a row on first append and relays the chunk live', async () => {
    const { service, repository, gateway } = build();

    await service.appendChunk('op-1', 'cluster-1', 'hello\n', '/var/log/x');

    expect(repository.save).toHaveBeenCalled();
    expect(gateway.emitLogChunk).toHaveBeenCalledWith(
      'op-1',
      'cluster-1',
      expect.objectContaining({ chunk: 'hello\n' }),
    );
  });

  it('does nothing for an empty chunk', async () => {
    const { service, repository, gateway } = build({
      content: '',
      truncated: false,
    });

    await service.appendChunk('op-1', 'cluster-1', '', '/var/log/x');

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    expect(gateway.emitLogChunk).not.toHaveBeenCalled();
  });

  it('skips a row that already hit the cap without emitting', async () => {
    const { service, gateway, repository } = build({
      content: 'already full',
      truncated: true,
    });

    await service.appendChunk('op-1', 'cluster-1', 'more output', '/var/log/x');

    expect(repository.createQueryBuilder).not.toHaveBeenCalled();
    expect(gateway.emitLogChunk).not.toHaveBeenCalled();
  });

  it('defaults the offset to zero when nothing has been captured yet', async () => {
    const { service } = build();
    const offset = await service.getOffset('missing-op');
    expect(offset).toEqual({ byteOffset: 0, truncated: false });
  });

  it('redacts a password before it is stored or relayed', async () => {
    const { service, gateway } = build();

    await service.appendChunk(
      'op-1',
      'cluster-1',
      'Redis:      redis:6379 (password: sup3r-secret) — cluster-internal\n',
      '/var/log/x',
    );

    const emitted = gateway.emitLogChunk.mock.calls[0][2].chunk;
    expect(emitted).not.toContain('sup3r-secret');
    expect(emitted).toContain('password: [redacted]');
  });
});

import { AuditService } from './audit.service';

describe('reading the activity record a page at a time', () => {
  const qb = {
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const service = new AuditService({
    createQueryBuilder: () => qb,
  } as never);

  beforeEach(() => jest.clearAllMocks());

  it('orders by time and then id, so records written in the same instant keep one order', async () => {
    await service.list({ limit: 50 });
    expect(qb.orderBy).toHaveBeenCalledWith('e.at', 'DESC');
    expect(qb.addOrderBy).toHaveBeenCalledWith('e.id', 'DESC');
    expect(qb.take).toHaveBeenCalledWith(50);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('continues after the last record seen, comparing in the database at full precision', async () => {
    const before = '6f1c2a4e-1b7d-4c1e-9a55-0c8b1f3e2d10';
    await service.list({ limit: 50, before, outcome: 'refused' });
    expect(qb.andWhere).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\(e\.at, e\.id\) < \(SELECT b\.at, b\.id FROM audit_events b WHERE b\.id = :before\)$/,
      ),
      { before },
    );
    expect(qb.andWhere).toHaveBeenCalledWith('e.outcome = :outcome', {
      outcome: 'refused',
    });
  });
});

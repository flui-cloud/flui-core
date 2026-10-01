import { QueryRunner } from 'typeorm';
import { CloseDeletedClusterIntervals1790000000013 } from './1790000000013-CloseDeletedClusterIntervals';

function recorder() {
  const statements: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return [];
    }),
  };
  return { runner: runner as unknown as QueryRunner, statements };
}

describe('CloseDeletedClusterIntervals1790000000013', () => {
  it('makes a node consecutive before closing deleted clusters, and only then enforces one open lifetime', async () => {
    const { runner, statements } = recorder();

    await new CloseDeletedClusterIntervals1790000000013().up(runner);

    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain('LEAD("startedAt")');
    expect(statements[1]).toContain(
      'UPDATE "infrastructure_node_billable_intervals"',
    );
    expect(statements[2]).toContain(
      'UPDATE "infrastructure_volume_billable_intervals"',
    );
    for (const close of statements.slice(1, 3)) {
      expect(close).toContain(
        'GREATEST(i."startedAt", COALESCE(c."deletedAt", c."updatedAt"))',
      );
      expect(close).toContain(`c."status" = 'deleted'`);
    }
    expect(statements[3]).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_node_billable_intervals_open_node"',
    );
    expect(statements[3]).toContain('WHERE "endedAt" IS NULL');
  });

  it('touches only lifetimes still open, so a second run changes nothing', async () => {
    const { runner, statements } = recorder();

    await new CloseDeletedClusterIntervals1790000000013().up(runner);

    for (const update of statements.filter((s) => s.startsWith('UPDATE'))) {
      expect(update).toContain('i."endedAt" IS NULL');
    }
  });
});

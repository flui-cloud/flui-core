import { QueryRunner } from 'typeorm';
import { ClusterEgressPolicy1790000000023 } from './1790000000023-ClusterEgressPolicy';
import { migrations } from './index';

describe('ClusterEgressPolicy1790000000023', () => {
  it('adds one nullable column, so every cluster stays open', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        return [];
      }),
    } as unknown as QueryRunner;
    await new ClusterEgressPolicy1790000000023().up(runner);
    expect(statements).toEqual([
      'ALTER TABLE "infrastructure_clusters" ADD COLUMN IF NOT EXISTS "egressPolicy" jsonb',
    ]);
  });

  it('is registered after the sandbox activity', () => {
    const at = migrations.indexOf(ClusterEgressPolicy1790000000023);
    expect(migrations[at - 1].name).toBe('SandboxActivity1790000000022');
  });
});

import { migrations } from './index';
import { InferenceUsageIpHash1790000000043 } from './1790000000043-InferenceUsageIpHash';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('InferenceUsageIpHash1790000000043', () => {
  it('adds a nullable address hash to the ledger, indexed with time only where set', async () => {
    const sql = await capture((q) =>
      new InferenceUsageIpHash1790000000043().up(q),
    );
    expect(sql).toEqual([
      'ALTER TABLE "inference_usage_events" ADD COLUMN IF NOT EXISTS "ipHash" character varying(64)',
      'CREATE INDEX IF NOT EXISTS "idx_inference_usage_ip_created" ON "inference_usage_events" ("ipHash", "createdAt") WHERE "ipHash" IS NOT NULL',
    ]);
  });

  it('drops the index, then the column', async () => {
    const sql = await capture((q) =>
      new InferenceUsageIpHash1790000000043().down(q),
    );
    expect(sql).toEqual([
      'DROP INDEX IF EXISTS "idx_inference_usage_ip_created"',
      'ALTER TABLE "inference_usage_events" DROP COLUMN IF EXISTS "ipHash"',
    ]);
  });

  it('runs right after the app history indexes', () => {
    const at = migrations.indexOf(InferenceUsageIpHash1790000000043);
    expect(migrations[at - 1].name).toBe('AppHistoryIndexes1790000000042');
  });
});

import { migrations } from './index';
import { InferenceUsageCachedTokens1790000000044 } from './1790000000044-InferenceUsageCachedTokens';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('InferenceUsageCachedTokens1790000000044', () => {
  it('adds the cached share of the prompt to the ledger, zero for old rows', async () => {
    const sql = await capture((q) =>
      new InferenceUsageCachedTokens1790000000044().up(q),
    );
    expect(sql).toEqual([
      'ALTER TABLE "inference_usage_events" ADD COLUMN IF NOT EXISTS "cachedPromptTokens" integer NOT NULL DEFAULT 0',
    ]);
  });

  it('drops the column', async () => {
    const sql = await capture((q) =>
      new InferenceUsageCachedTokens1790000000044().down(q),
    );
    expect(sql).toEqual([
      'ALTER TABLE "inference_usage_events" DROP COLUMN IF EXISTS "cachedPromptTokens"',
    ]);
  });

  it('runs after the address hash, right before the database HA column', () => {
    const at = migrations.indexOf(InferenceUsageCachedTokens1790000000044);
    expect(migrations[at - 1].name).toBe('InferenceUsageIpHash1790000000043');
    expect(migrations[at + 1].name).toBe('DatabaseHa1790000000045');
  });
});

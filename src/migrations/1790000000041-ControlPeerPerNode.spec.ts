import { migrations } from './index';
import { ControlPeerPerNode1790000000041 } from './1790000000041-ControlPeerPerNode';

const capture = async (run: (q: never) => Promise<void>) => {
  const sql: string[] = [];
  await run({ query: async (q: string) => void sql.push(q) } as never);
  return sql;
};

describe('ControlPeerPerNode1790000000041', () => {
  it('adds both columns idempotently', async () => {
    const sql = await capture((q) =>
      new ControlPeerPerNode1790000000041().up(q),
    );
    expect(sql[0]).toContain('ADD COLUMN IF NOT EXISTS "isPrimary" boolean');
    expect(sql[1]).toContain('ADD COLUMN IF NOT EXISTS "controlHandshakes"');
  });

  it('marks the one control row there was as primary before giving it a node', async () => {
    const sql = await capture((q) =>
      new ControlPeerPerNode1790000000041().up(q),
    );
    const primary = sql.findIndex((s) => s.includes('SET "isPrimary" = true'));
    const backfill = sql.findIndex((s) => s.includes('SET "nodeId" = master'));
    expect(primary).toBeGreaterThan(-1);
    expect(sql[primary]).toContain('ORDER BY "createdAt" ASC LIMIT 1');
    expect(backfill).toBeGreaterThan(primary);
    expect(sql[backfill]).toContain(`n."nodeType" = 'master'`);
    expect(sql[backfill]).toContain('c."nodeId" IS NULL');
  });

  it('picks the newest master that is neither being deleted nor failed', async () => {
    const sql = await capture((q) =>
      new ControlPeerPerNode1790000000041().up(q),
    );
    const masters = sql.filter((s) => s.includes('WITH master AS'));
    expect(masters).toHaveLength(2);
    for (const statement of masters) {
      expect(statement).toContain(`n."status" NOT IN ('deleting', 'error')`);
      expect(statement).toContain('ORDER BY n."clusterId", n."createdAt" DESC');
      expect(statement).not.toContain('n."createdAt" ASC');
    }
  });

  it('withdraws a member reservation on the master before the backfill, so one node never holds two live rows', async () => {
    const sql = await capture((q) =>
      new ControlPeerPerNode1790000000041().up(q),
    );
    const revoke = sql.findIndex((s) => s.includes(`SET "status" = 'revoked'`));
    const backfill = sql.findIndex((s) => s.includes('SET "nodeId" = master'));
    expect(revoke).toBeGreaterThan(-1);
    expect(revoke).toBeLessThan(backfill);
    expect(sql[revoke]).toContain(`m."role" = 'member'`);
  });

  it('keeps at most one live primary', async () => {
    const sql = await capture((q) =>
      new ControlPeerPerNode1790000000041().up(q),
    );
    expect(sql[sql.length - 1]).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_wg_peers_live_primary"',
    );
  });

  it('goes back to a single control row with no node', async () => {
    const sql = await capture((q) =>
      new ControlPeerPerNode1790000000041().down(q),
    );
    expect(sql[0]).toBe('DROP INDEX IF EXISTS "UQ_wg_peers_live_primary"');
    expect(sql[1]).toContain(`"isPrimary" = false`);
    expect(sql[2]).toContain('SET "nodeId" = NULL');
    expect(sql.slice(-2).join('\n')).toMatch(
      /DROP COLUMN IF EXISTS "isPrimary"/,
    );
  });

  it('runs right after the identity console state', () => {
    const at = migrations.indexOf(ControlPeerPerNode1790000000041);
    expect(migrations[at - 1].name).toBe('IdentityConsoleState1790000000040');
  });
});

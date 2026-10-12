jest.mock('@kubernetes/client-node', () => ({}));

import {
  DbWriteFenceService,
  HBA_ERRORS_SQL,
  TERMINATE_TCP_CLIENTS_SQL,
  fenceScript,
  unfenceScript,
} from './db-write-fence.service';

const target = { appId: 'src-app' } as any;

function setup(
  over: { errors?: string; verify?: string[]; after?: string } = {},
) {
  const calls: string[] = [];
  const verify = [...(over.verify ?? ['0|0|2'])];
  const exec = {
    execRaw: jest.fn(async (_t: unknown, script: string) => {
      calls.push(`raw:${script.includes('sed -i') ? 'unfence' : 'fence'}`);
      return script.includes('sed -i')
        ? `FLUI_FENCE_AFTER=${over.after ?? 'abc123'}\n`
        : 'FLUI_FENCE_BEFORE=abc123\n';
    }),
    execSql: jest.fn(async (_t: unknown, sql: string) => {
      if (sql === HBA_ERRORS_SQL) {
        calls.push('errors');
        return over.errors ?? '0';
      }
      if (sql.includes('pg_reload_conf')) {
        calls.push('reload');
        return 't';
      }
      if (sql === TERMINATE_TCP_CLIENTS_SQL) {
        calls.push('terminate');
        return '3';
      }
      calls.push('verify');
      return verify.length > 1 ? (verify.shift() as string) : verify[0];
    }),
  };
  return { svc: new DbWriteFenceService(exec as any), calls, exec };
}

describe('DbWriteFenceService', () => {
  it('prepends a reject block for every TCP client, once, and reports the original checksum', () => {
    const script = fenceScript('flui:fence:0123456789ab');
    expect(script).toContain(
      "printf '# flui:fence:0123456789ab:begin\\nhost all all 0.0.0.0/0 reject\\nhost all all ::/0 reject\\n# flui:fence:0123456789ab:end\\n'",
    );
    expect(script).toContain('cat "$HBA"; } > "$HBA.flui"');
    expect(script).toContain(
      'if ! grep -qx \'# flui:fence:0123456789ab:begin\' "$HBA"; then',
    );
    expect(script).toContain(
      'BEFORE=$(sed \'/^# flui:fence:0123456789ab:begin$/,/^# flui:fence:0123456789ab:end$/d\' "$HBA" | sha256sum',
    );
  });

  it('removes exactly its own block on undo', () => {
    expect(unfenceScript('flui:fence:0123456789ab')).toContain(
      'sed -i \'/^# flui:fence:0123456789ab:begin$/,/^# flui:fence:0123456789ab:end$/d\' "$HBA"',
    );
  });

  it('refuses a marker that could break out of the script', () => {
    expect(() => fenceScript("flui:fence:x'; rm -rf /")).toThrow();
  });

  it('records the fence before the reload, checks the file parses, then reloads and terminates TCP clients only', async () => {
    const { svc, calls } = setup();
    const persisted: string[] = [];
    const record = await svc.fence(
      target,
      'flui:fence:0123456789ab',
      async (r) => {
        persisted.push(`persist:${r.hbaSha256Before}`);
        calls.push('persist');
      },
    );
    expect(calls).toEqual([
      'raw:fence',
      'persist',
      'errors',
      'reload',
      'terminate',
      'verify',
      'persist',
    ]);
    expect(TERMINATE_TCP_CLIENTS_SQL).toContain(
      "backend_type = 'client backend' AND client_addr IS NOT NULL",
    );
    expect(record).toMatchObject({
      method: 'pg_hba',
      marker: 'flui:fence:0123456789ab',
      hbaSha256Before: 'abc123',
      terminatedSessions: 3,
      releasedAt: null,
    });
    expect(persisted[0]).toBe('persist:abc123');
  });

  it('never reloads a file with a parse error', async () => {
    const { svc, calls } = setup({ errors: '1' });
    await expect(
      svc.fence(target, 'flui:fence:0123456789ab', async () => undefined),
    ).rejects.toThrow(/error line/);
    expect(calls).not.toContain('reload');
  });

  it('waits until no TCP session and no open write is left', async () => {
    const { svc, calls } = setup({ verify: ['1|0|2', '0|1|2', '0|0|2'] });
    await svc.fence(target, 'flui:fence:0123456789ab', async () => undefined);
    expect(calls.filter((c) => c === 'verify')).toHaveLength(3);
  });

  it('undoes the fence and confirms the file is back to its checksum', async () => {
    const { svc, calls } = setup();
    const released = await svc.unfence(target, {
      method: 'pg_hba',
      marker: 'flui:fence:0123456789ab',
      hbaSha256Before: 'abc123',
      appliedAt: '2026-10-11T00:00:00Z',
    });
    expect(calls).toEqual(['raw:unfence', 'errors', 'reload']);
    expect(released.releasedAt).toBeTruthy();
    expect(released.releaseNote).toBeNull();
  });

  it('keeps someone else’s edit and says so when the checksum differs', async () => {
    const { svc } = setup({ after: 'ffff' });
    const released = await svc.unfence(target, {
      method: 'pg_hba',
      marker: 'flui:fence:0123456789ab',
      hbaSha256Before: 'abc123',
      appliedAt: '2026-10-11T00:00:00Z',
    });
    expect(released.releaseNote).toMatch(/changed while fenced/);
  });
});

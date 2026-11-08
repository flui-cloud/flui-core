import {
  singleInstanceSelector,
  HA_REPLICATION_ROLE,
  caughtUpSql,
  copyHbaScript,
  fenceSql,
  primarySelectorPatch,
  promotionPatch,
  renderCnpgCopyCluster,
  sourceRolesSql,
} from './postgres-ha-migration.core';

describe('moving a single Postgres into a highly available one', () => {
  /** Flui's image has no `postgres` role, and the operator's agent connects as it. */
  it('gives the source the roles the operator expects in what it copies', () => {
    const sql = sourceRolesSql(`'pw'`).join('\n');
    expect(sql).toContain('CREATE ROLE postgres WITH SUPERUSER LOGIN');
    expect(sql).toContain(
      'CREATE ROLE streaming_replica WITH REPLICATION LOGIN',
    );
    expect(sql).toContain(
      `CREATE ROLE ${HA_REPLICATION_ROLE} WITH REPLICATION LOGIN PASSWORD 'pw'`,
    );
    expect(sql).toContain(
      `ALTER ROLE ${HA_REPLICATION_ROLE} WITH PASSWORD 'pw'`,
    );
  });

  it('lets only the pod network stream from the source, once', () => {
    const script = copyHbaScript('10.42.0.0/16');
    expect(script).toContain(
      `host replication ${HA_REPLICATION_ROLE} 10.42.0.0/16 scram-sha-256`,
    );
    expect(script).toContain(`grep -qx '# flui-ha-copy:begin'`);
    expect(() => copyHbaScript('0.0.0.0/0; rm -rf /')).toThrow(/pod network/);
  });

  it('stops writes on the source and reports where its log ends', () => {
    const sql = fenceSql();
    expect(sql[0]).toBe('ALTER SYSTEM SET default_transaction_read_only = on');
    expect(sql).toContain('SELECT pg_reload_conf()');
    expect(sql[sql.length - 1]).toBe('SELECT pg_current_wal_lsn()');
  });

  it('asks the copy whether it has replayed that far, and nothing else', () => {
    expect(caughtUpSql('0/14000000')).toBe(
      "SELECT pg_last_wal_replay_lsn() >= '0/14000000'::pg_lsn",
    );
    expect(() => caughtUpSql("0/1'; drop table x; --")).toThrow(/WAL position/);
  });

  it('starts the copy from the running instance and keeps it a replica until promoted', () => {
    const cluster = renderCnpgCopyCluster({
      name: 'orders-db-ha',
      namespace: 'p-orders',
      appId: 'app-1',
      instances: 3,
      preferredZones: ['fsn1', 'nbg1'],
      durability: 'required',
      storageClass: 'flui-local',
      sizeGi: 10,
      sourceHost: 'orders-db-svc',
      replicationSecret: 'orders-db-ha-repl',
    });
    const spec = cluster.spec as Record<string, any>;
    expect(spec.bootstrap).toEqual({
      pg_basebackup: { source: 'flui-single' },
    });
    expect(spec.replica).toEqual({ enabled: true, source: 'flui-single' });
    expect(spec.externalClusters[0]).toEqual({
      name: 'flui-single',
      connectionParameters: {
        host: 'orders-db-svc',
        user: HA_REPLICATION_ROLE,
        dbname: 'postgres',
        sslmode: 'disable',
      },
      password: { name: 'orders-db-ha-repl', key: 'password' },
    });
    expect(spec.imageName).toBe(
      'ghcr.io/cloudnative-pg/postgresql:17.11-standard-trixie@sha256:4d0aac315c4d8c3202252bd06fea83b16951cc57234a7b610eeaa382ff4482d0',
    );
    expect(spec.affinity.topologyKey).toBe('topology.kubernetes.io/zone');
    expect(
      spec.affinity.nodeAffinity
        .preferredDuringSchedulingIgnoredDuringExecution[0].preference
        .matchExpressions[0].values,
    ).toEqual(['fsn1', 'nbg1']);
  });

  it('promotes the copy and points the application at its primary', () => {
    expect(promotionPatch()).toEqual({ spec: { replica: { enabled: false } } });
    expect(primarySelectorPatch('orders-db', 'orders-db-ha')).toEqual({
      spec: {
        selector: {
          app: null,
          'cnpg.io/cluster': 'orders-db-ha',
          'cnpg.io/instanceRole': 'primary',
        },
      },
      metadata: {
        annotations: { 'flui.cloud/ha-previous-selector': 'orders-db' },
      },
    });
  });
});

describe('the single instance while its copy exists', () => {
  it('leaves out the pods of the copy, which carry the same application id', () => {
    expect(singleInstanceSelector('flui-app-id=a1')).toBe(
      'flui-app-id=a1,!cnpg.io/cluster',
    );
  });
});

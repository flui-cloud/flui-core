import { NotFoundException } from '@nestjs/common';
import { SystemDbAccessService } from './system-db-access.service';
import { SystemDbAuditService } from './system-db-audit.service';
import { CONSOLE_TARGET_ABSENT } from '../constants/platform-foundations';
import { ClusterType } from '../../infrastructure/clusters/entities/cluster.entity';

function serviceOver(clusters: Array<{ id: string; clusterType: string }>) {
  const audit = { emit: jest.fn() };
  const repo = {
    findOne: jest.fn(async ({ where }: { where: { clusterType: unknown } }) => {
      const wanted = (where.clusterType as { value: string[] }).value;
      return clusters.find((c) => wanted.includes(c.clusterType)) ?? null;
    }),
  };
  const service = new SystemDbAccessService(
    repo as never,
    audit as unknown as SystemDbAuditService,
  );
  return { service, audit, repo };
}

const CONTROL = [{ id: 'cluster-control', clusterType: ClusterType.CONTROL }];

/**
 * Coordinates and nothing else. What makes this safe is not who calls it — the
 * guard answers that — but what it declines to do: no connection, no tunnel, no
 * Secret, no password.
 */
describe('where the platform database is', () => {
  it("answers the platform Postgres with Flui's own database and role", async () => {
    const { service } = serviceOver(CONTROL);
    await expect(
      service.connectionInfo('platform-postgres', 'u1'),
    ).resolves.toEqual({
      engine: 'postgres',
      database: 'fluicloud',
      user: 'fluicloud',
      namespace: 'flui-system',
      podLabelSelector: 'app=postgres',
      clusterId: 'cluster-control',
      remotePort: 5432,
    });
  });

  it('sends the identity provider to the same pod and a different database', async () => {
    const { service } = serviceOver(CONTROL);
    const info = await service.connectionInfo('identity-provider', 'u1');
    expect({
      namespace: info.namespace,
      selector: info.podLabelSelector,
      port: info.remotePort,
      database: info.database,
      user: info.user,
    }).toEqual({
      namespace: 'flui-system',
      selector: 'app=postgres',
      port: 5432,
      database: 'zitadel',
      user: 'zitadel_user',
    });
  });

  it('never returns a password, whatever was asked for', async () => {
    const { service } = serviceOver(CONTROL);
    const info = await service.connectionInfo('platform-postgres', 'u1');
    expect(Object.keys(info).sort((a, b) => a.localeCompare(b))).toEqual([
      'clusterId',
      'database',
      'engine',
      'namespace',
      'podLabelSelector',
      'remotePort',
      'user',
    ]);
  });

  /**
   * Installations provisioned before the rename still say `observability` for
   * the control cluster, and a lookup that reads only the new value is a
   * feature that works nowhere it matters.
   */
  it('finds the control cluster on installations that still call it observability', async () => {
    const { service } = serviceOver([
      { id: 'cluster-legacy', clusterType: ClusterType.OBSERVABILITY },
    ]);
    await expect(
      (await service.connectionInfo('platform-postgres', 'u1')).clusterId,
    ).toBe('cluster-legacy');
  });

  /**
   * The same absence a console gives, so getting past the guard does not let
   * somebody enumerate the foundations by probing keys.
   */
  it('answers absence for a key that names no foundation', async () => {
    const { service } = serviceOver(CONTROL);
    const asked = service.connectionInfo('grafana', 'u1');
    await expect(asked).rejects.toBeInstanceOf(NotFoundException);
    await expect(asked).rejects.toThrow(CONSOLE_TARGET_ABSENT);
  });

  it('answers absence when there is no control cluster to point at', async () => {
    const { service } = serviceOver([]);
    await expect(
      service.connectionInfo('platform-postgres', 'u1'),
    ).rejects.toThrow(CONSOLE_TARGET_ABSENT);
  });

  it('records the grant with the cluster it handed out', async () => {
    const { service, audit } = serviceOver(CONTROL);
    await service.connectionInfo('platform-postgres', 'u1');
    expect(audit.emit).toHaveBeenCalledWith({
      foundationKey: 'platform-postgres',
      userId: 'u1',
      clusterId: 'cluster-control',
      result: 'allow',
      reason: null,
    });
  });

  it('records the probe for a key nobody declared', async () => {
    const { service, audit } = serviceOver(CONTROL);
    await expect(service.connectionInfo('grafana', 'u1')).rejects.toThrow();
    expect(audit.emit).toHaveBeenCalledWith({
      foundationKey: 'grafana',
      userId: 'u1',
      result: 'deny',
      reason: 'unknown_foundation',
    });
  });
});

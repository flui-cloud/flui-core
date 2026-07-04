import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../infrastructure/clusters/entities/cluster-node.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { REPL_ROLE } from '../constants';
import { DbPodExecService, ResolvedApp } from './db-pod-exec.service';

export interface ExternalPath {
  host: string;
  port: number;
  svcName: string;
  caPath: string;
}

/**
 * Cross-cluster wire for a pulling subscriber: pinned self-signed TLS
 * (reloadable, no restart), the repl role forced TLS-only via pg_hba, a
 * dedicated NodePort Service, and the CA dropped on the DESTINATION's PVC so
 * the subscription survives dst pod restarts.
 */
@Injectable()
export class DbReplicationTransportService {
  private readonly logger = new Logger(DbReplicationTransportService.name);

  constructor(
    private readonly exec: DbPodExecService,
    private readonly k8s: KubernetesService,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepo: Repository<ClusterNodeEntity>,
  ) {}

  async prepareExternalPath(
    src: ResolvedApp,
    dst: ResolvedApp,
    short: string,
  ): Promise<ExternalPath> {
    await this.exec.execRaw(
      src,
      [
        'set -e',
        `cd ${src.pvcRoot}`,
        'if [ ! -s flui-repl-server.crt ]; then',
        `  openssl req -x509 -newkey rsa:2048 -keyout flui-repl-server.key -out flui-repl-server.crt -days 3650 -nodes -subj "/CN=${src.slug}" >/dev/null 2>&1`,
        '  chown postgres:postgres flui-repl-server.key flui-repl-server.crt',
        '  chmod 600 flui-repl-server.key',
        'fi',
        'HBA="$PGDATA/pg_hba.conf"',
        `if ! grep -q 'hostnossl all ${REPL_ROLE}' "$HBA"; then`,
        `  sed -i '1i hostnossl all ${REPL_ROLE} ::0/0 reject' "$HBA"`,
        `  sed -i '1i hostnossl all ${REPL_ROLE} 0.0.0.0/0 reject' "$HBA"`,
        '  chown postgres:postgres "$HBA"',
        'fi',
      ].join('\n'),
    );
    await this.exec.execSql(
      src,
      [
        `ALTER SYSTEM SET ssl = on;`,
        `ALTER SYSTEM SET ssl_cert_file = '${src.pvcRoot}/flui-repl-server.crt';`,
        `ALTER SYSTEM SET ssl_key_file = '${src.pvcRoot}/flui-repl-server.key';`,
        `SELECT pg_reload_conf();`,
      ].join('\n'),
    );

    const svcName = `flui-repl-${short}`;
    const manifest = [
      'apiVersion: v1',
      'kind: Service',
      'metadata:',
      `  name: ${svcName}`,
      `  namespace: ${src.namespace}`,
      '  labels:',
      '    managed-by: flui-cloud',
      '    flui-resource-type: db-replication-endpoint',
      '  annotations:',
      '    flui.cloud/purpose: db-replication',
      'spec:',
      '  type: NodePort',
      '  selector:',
      `    flui-app-id: ${src.appId}`,
      '  ports:',
      '    - name: postgres',
      '      port: 5432',
      '      targetPort: 5432',
      '      protocol: TCP',
    ].join('\n');
    await this.k8s.applyManifest(src.kubeconfig, manifest);
    const nodePort = await this.k8s.getServiceNodePort(
      src.kubeconfig,
      src.namespace,
      svcName,
    );
    if (!nodePort) {
      throw new BadRequestException(
        'Could not allocate a NodePort for the replication endpoint',
      );
    }

    const nodes = await this.nodeRepo.find({
      where: { clusterId: src.clusterId },
    });
    const host = (
      nodes.find((n) => n.nodeType === NodeType.MASTER && n.ipAddress) ??
      nodes.find((n) => n.ipAddress)
    )?.ipAddress;
    if (!host) {
      throw new BadRequestException(
        'Source cluster has no public node IP for external replication',
      );
    }

    const certPem = await this.exec.execRaw(
      src,
      `cat ${src.pvcRoot}/flui-repl-server.crt`,
    );
    const caPath = `${dst.pvcRoot}/flui-repl-ca-${short}.crt`;
    const b64 = Buffer.from(certPem, 'utf-8').toString('base64');
    await this.exec.execRaw(
      dst,
      `echo ${b64} | base64 -d > ${caPath} && chown postgres:postgres ${caPath} && chmod 0644 ${caPath}`,
    );

    // Provider firewall automation lands with the paid two-cluster E2E; until
    // then reachability is on the operator (BYOS hosts have no managed FW).
    this.logger.warn(
      `[db-repl] external transport: ensure tcp/${nodePort} on the source cluster nodes accepts connections from the destination cluster`,
    );

    // kube-proxy needs a moment to program the fresh NodePort — probing from
    // the DESTINATION also proves the path CREATE SUBSCRIPTION will use.
    await this.exec.execRaw(
      dst,
      `for i in $(seq 1 30); do pg_isready -h ${host} -p ${nodePort} -t 3 >/dev/null 2>&1 && exit 0; sleep 2; done; echo "replication endpoint ${host}:${nodePort} not reachable from destination" >&2; exit 1`,
    );
    return { host, port: nodePort, svcName, caPath };
  }

  /** Best-effort removal of the NodePort endpoint an external link created. */
  async teardownExternal(
    link: DbReplicationLinkEntity,
    src: ResolvedApp | null,
  ): Promise<void> {
    const t = link.transport;
    if (t?.mode !== 'external' || !t.svcName || !src) return;
    await this.k8s
      .deleteResource(src.kubeconfig, 'Service', t.svcName, src.namespace)
      .catch((err) =>
        this.logger.warn(
          `[db-repl] could not delete replication endpoint ${t.svcName}: ${err?.message}`,
        ),
      );
  }
}

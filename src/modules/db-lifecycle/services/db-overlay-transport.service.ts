import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { DbPodExecService, ResolvedApp } from './db-pod-exec.service';

export const STANDBY_DIR = 'flui-standby';
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export interface StandbyFiles {
  caPath: string;
  caPem: string;
  slot: string;
  conninfo: string;
}

/**
 * The source Postgres on its node's overlay address: a Service whose external
 * IP is that address, with `externalTrafficPolicy: Local` so only the node
 * hosting the pod answers and the client address survives for `pg_hba`.
 * Nothing listens on a public address.
 */
export function overlayServiceManifest(
  src: Pick<ResolvedApp, 'appId' | 'namespace'>,
  name: string,
  overlayIp: string,
  port: number,
): string {
  assertIp(overlayIp);
  return [
    'apiVersion: v1',
    'kind: Service',
    'metadata:',
    `  name: ${name}`,
    `  namespace: ${src.namespace}`,
    '  labels:',
    '    managed-by: flui-cloud',
    '    flui-resource-type: db-replication-endpoint',
    '  annotations:',
    '    flui.cloud/purpose: db-replication',
    'spec:',
    '  type: ClusterIP',
    '  selector:',
    `    flui-app-id: ${src.appId}`,
    '  externalIPs:',
    `    - ${overlayIp}`,
    '  externalTrafficPolicy: Local',
    '  ports:',
    '    - name: postgres',
    `      port: ${port}`,
    '      targetPort: 5432',
    '      protocol: TCP',
  ].join('\n');
}

/** Lets the destination pod reach the source's overlay endpoint and, while it
 *  is a standby, nothing else. Additive to any policy the namespace has. */
export function standbyEgressManifest(
  dst: Pick<ResolvedApp, 'appId' | 'namespace'>,
  name: string,
  overlayIp: string,
  port: number,
): string {
  assertIp(overlayIp);
  return [
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    `  name: ${name}`,
    `  namespace: ${dst.namespace}`,
    '  labels:',
    '    app.kubernetes.io/managed-by: flui',
    'spec:',
    '  podSelector:',
    '    matchLabels:',
    `      flui-app-id: ${dst.appId}`,
    '  policyTypes:',
    '    - Egress',
    '  egress:',
    '    - to:',
    '        - ipBlock:',
    `            cidr: ${overlayIp}/32`,
    '      ports:',
    '        - protocol: TCP',
    `          port: ${port}`,
  ].join('\n');
}

export function assertIp(ip: string): void {
  if (!IPV4_RE.test(ip)) throw new Error(`Not an overlay address: ${ip}`);
}

@Injectable()
export class DbOverlayTransportService {
  private readonly logger = new Logger(DbOverlayTransportService.name);

  constructor(
    private readonly exec: DbPodExecService,
    private readonly k8s: KubernetesService,
  ) {}

  /**
   * TLS on the source, reloadable, no restart. Only turned on when it was
   * off, and that is recorded so cleanup puts it back.
   */
  async ensureTls(src: ResolvedApp): Promise<{ sslWasOn: boolean }> {
    const sslWasOn =
      (await this.exec.execSql(src, 'SHOW ssl;')).trim() === 'on';
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
      ].join('\n'),
    );
    if (!sslWasOn) {
      await this.exec.execSql(
        src,
        [
          `ALTER SYSTEM SET ssl = on;`,
          `ALTER SYSTEM SET ssl_cert_file = '${src.pvcRoot}/flui-repl-server.crt';`,
          `ALTER SYSTEM SET ssl_key_file = '${src.pvcRoot}/flui-repl-server.key';`,
          `SELECT pg_reload_conf();`,
        ].join('\n'),
      );
    }
    return { sslWasOn };
  }

  async serverCertificate(src: ResolvedApp): Promise<string> {
    return this.exec.execRaw(src, `cat ${src.pvcRoot}/flui-repl-server.crt`);
  }

  async expose(
    src: ResolvedApp,
    name: string,
    overlayIp: string,
    port: number,
  ): Promise<void> {
    await this.k8s.applyManifest(
      src.kubeconfig,
      overlayServiceManifest(src, name, overlayIp, port),
    );
  }

  async restrictEgress(
    dst: ResolvedApp,
    name: string,
    overlayIp: string,
    port: number,
  ): Promise<void> {
    await this.k8s.applyManifest(
      dst.kubeconfig,
      standbyEgressManifest(dst, name, overlayIp, port),
    );
  }

  /**
   * Drops what the standby bootstrap waits for. The connection string carries
   * the replication password, so it rides stdin and lands mode 600; the slot
   * goes first, the connection last, each by rename, so the entrypoint never
   * reads half a file.
   */
  async attachStandby(dst: ResolvedApp, files: StandbyFiles): Promise<void> {
    const dir = `${dst.pvcRoot}/${STANDBY_DIR}`;
    const ca = Buffer.from(files.caPem, 'utf-8').toString('base64');
    const slot = Buffer.from(files.slot, 'utf-8').toString('base64');
    await this.exec.execRaw(
      dst,
      [
        'set -e',
        `mkdir -p ${dir} && chown postgres:postgres ${dir} && chmod 700 ${dir}`,
        `echo ${ca} | base64 -d > ${files.caPath} && chown postgres:postgres ${files.caPath} && chmod 0644 ${files.caPath}`,
        `echo ${slot} | base64 -d > ${dir}/slot.tmp && chown postgres:postgres ${dir}/slot.tmp && mv ${dir}/slot.tmp ${dir}/slot`,
      ].join('\n'),
    );
    await this.exec.execWithInput(
      dst,
      `umask 077 && cat > ${dir}/conninfo.tmp && chown postgres:postgres ${dir}/conninfo.tmp && chmod 600 ${dir}/conninfo.tmp && mv ${dir}/conninfo.tmp ${dir}/conninfo`,
      files.conninfo,
    );
  }

  /** Probed from inside the destination pod: the path the base backup takes. */
  async probe(dst: ResolvedApp, host: string, port: number): Promise<void> {
    assertIp(host);
    await this.exec.execRaw(
      dst,
      `for i in $(seq 1 30); do pg_isready -h ${host} -p ${port} -t 3 >/dev/null 2>&1 && exit 0; sleep 2; done; echo "source ${host}:${port} not reachable from the destination pod" >&2; exit 1`,
    );
  }

  async withdraw(
    src: ResolvedApp | null,
    dst: ResolvedApp | null,
    names: { svcName?: string; netpolName?: string },
  ): Promise<void> {
    if (src && names.svcName) {
      await this.k8s
        .deleteResource(src.kubeconfig, 'Service', names.svcName, src.namespace)
        .catch((err) =>
          this.logger.warn(
            `[db-repl] could not delete ${names.svcName}: ${err?.message}`,
          ),
        );
    }
    if (dst && names.netpolName) {
      await this.k8s
        .deleteResource(
          dst.kubeconfig,
          'NetworkPolicy',
          names.netpolName,
          dst.namespace,
        )
        .catch((err) =>
          this.logger.warn(
            `[db-repl] could not delete ${names.netpolName}: ${err?.message}`,
          ),
        );
    }
  }
}

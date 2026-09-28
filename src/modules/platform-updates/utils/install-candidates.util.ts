import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { RELEASE } from '../../../config/release.config';
import { MasterKind } from '../services/bootstrap-files.service';
import { InstallRecord } from './install-values.util';

export const CONTROL_REMOTE_WRITE_URL =
  'http://vmsingle.flui-control.svc.cluster.local:8428/api/v1/write';
export const WORKLOAD_INGEST_PORT = 30428;
const MAX_CANDIDATE_REFS = 8;

export const nonEmpty = (values: Array<string | null | undefined>): string[] =>
  values.filter((v): v is string => typeof v === 'string' && v.length > 0);

const dashed = (ip: string): string => ip.replaceAll('.', '-');

/** Releases a master may have been built from, most likely first. */
export function candidateRefList(
  record: InstallRecord | null,
  cluster: Pick<ClusterEntity, 'bootstrapRef'>,
  published: string[],
): string[] {
  return [
    ...new Set(
      nonEmpty([
        record?.bootstrapRef,
        cluster.bootstrapRef,
        RELEASE.bootstrapRef,
        ...published,
      ]),
    ),
  ].slice(0, MAX_CANDIDATE_REFS);
}

/** The hosts the IngressRoutes answer on. */
export function routeHostsOf(routes: any[]): string[] {
  return routes.flatMap((r: any) =>
    (r?.spec?.routes ?? []).flatMap((route: any) =>
      [...String(route?.match ?? '').matchAll(/Host\(`([^`]+)`\)/g)].map(
        (m) => m[1],
      ),
    ),
  );
}

export function parseWebConfig(
  json: string | undefined,
): Record<string, unknown> {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
}

/** Where a metrics agent's Deployment tells it to push. */
export function remoteWriteOf(live: any): string | null {
  for (const c of live?.spec?.template?.spec?.containers ?? []) {
    for (const arg of c?.args ?? []) {
      const match =
        typeof arg === 'string' ? /^-remoteWrite\.url=(.+)$/.exec(arg) : null;
      if (match) return match[1];
    }
  }
  return null;
}

export interface CandidateSources {
  cluster: ClusterEntity;
  kind: MasterKind;
  env: NodeJS.ProcessEnv;
  apiConfig: Record<string, string>;
  webConfig: Record<string, unknown>;
  routeHosts: string[];
  remoteWrites: string[];
  running: Record<string, string>;
  secretVariables: ReadonlySet<string>;
}

/**
 * Every value a master's files may have been rendered with, from what Flui
 * already knows. Secret variables are never candidates: a file that renders
 * one cannot be proven, and stays that way.
 */
export function candidateValues(
  sources: CandidateSources,
): Record<string, string[]> {
  const { cluster, kind, env, apiConfig, webConfig, routeHosts, running } =
    sources;
  const master = (cluster.nodes ?? []).find((n) => n.nodeType === 'master');
  const token = cluster.nipHostnameToken ?? env.NIP_HOSTNAME_TOKEN;
  const ips = nonEmpty([
    env.FLUI_MASTER_PUBLIC_IP,
    cluster.masterIpAddress,
    env.MASTER_IP,
  ]);
  const stripApi = (url?: string) =>
    url
      ?.replace(/^https?:\/\//, '')
      .replace(/^api\./, '')
      .split('/', 1)[0];

  const out: Record<string, Array<string | null | undefined>> = {
    CLUSTER_ID: [cluster.id, env.CLUSTER_ID],
    CLUSTER_NAME: [cluster.name, env.CLUSTER_NAME],
    CLUSTER_TYPE: [kind],
    SERVER_ID: [master?.id, env.SERVER_ID],
    CLOUD_PROVIDER: [cluster.provider, env.CLOUD_PROVIDER],
    REMOTE_WRITE_URL:
      kind === 'control' ? [CONTROL_REMOTE_WRITE_URL] : sources.remoteWrites,
    MASTER_IP: [
      cluster.masterIpAddress,
      env.MASTER_IP,
      cluster.masterPrivateIp,
    ],
    FLUI_MASTER_PUBLIC_IP: ['', env.FLUI_MASTER_PUBLIC_IP],
    FLUI_BOOTSTRAP_NODE_PRIVATE_IP: [
      '',
      cluster.masterPrivateIp,
      env.FLUI_BOOTSTRAP_NODE_PRIVATE_IP,
    ],
    NIP_HOSTNAME_TOKEN: ['', token],
    FLUI_BASE_DOMAIN: [
      stripApi(apiConfig.API_BASE_URL),
      stripApi(env.API_BASE_URL),
      ...routeHosts
        .filter((h) => h.startsWith('api.'))
        .map((h) => h.slice('api.'.length)),
      ...ips.flatMap((ip) =>
        token
          ? [`${token}.${dashed(ip)}.nip.io`, `${dashed(ip)}.nip.io`]
          : [`${dashed(ip)}.nip.io`],
      ),
    ],
    AUTH_MODE: [apiConfig.AUTH_MODE, env.AUTH_MODE, 'local', 'oidc'],
    OIDC_ISSUER: ['', apiConfig.OIDC_ISSUER, env.OIDC_ISSUER],
    OIDC_JWKS_URI: ['', apiConfig.OIDC_JWKS_URI, env.OIDC_JWKS_URI],
    OIDC_AUDIENCE: [
      '',
      typeof webConfig.oidcClientId === 'string'
        ? webConfig.oidcClientId
        : undefined,
      env.OIDC_AUDIENCE,
    ],
    CERTIFICATE_MODE: [
      typeof webConfig.certificateMode === 'string'
        ? webConfig.certificateMode
        : undefined,
      'production',
      'staging',
      'preflight',
    ],
    FLUI_API_IMAGE_TAG: [
      running.FLUI_API_IMAGE_TAG,
      RELEASE.images.fluiApi,
      'latest',
    ],
    FLUI_WEB_IMAGE_TAG: [
      running.FLUI_WEB_IMAGE_TAG,
      RELEASE.images.fluiWeb,
      'latest',
    ],
  };
  for (const [k, v] of Object.entries(running)) {
    out[k] = [v, ...(out[k] ?? []), 'latest'];
  }

  const candidates: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(out)) {
    if (sources.secretVariables.has(k)) continue;
    candidates[k] = [
      ...new Set(list.filter((v): v is string => typeof v === 'string')),
    ];
  }
  return candidates;
}

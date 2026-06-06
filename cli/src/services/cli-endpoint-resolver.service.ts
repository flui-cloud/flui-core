import { Injectable, Logger } from '@nestjs/common';
import { CliSshService } from './cli-ssh.service';
import { buildNipBaseDomain } from '../lib/nip-base-domain.util';

export type SystemAppKey =
  | 'fluiApi'
  | 'fluiWeb'
  | 'zitadel'
  | 'grafana'
  | 'prometheus'
  | 'loki';

export interface EndpointInfo {
  fqdn: string | null;
  defaultUrl: string;
  effectiveUrl: string;
  synced: boolean;
}

export interface SystemEndpoints {
  fluiApi: EndpointInfo;
  fluiWeb: EndpointInfo;
  zitadel: EndpointInfo;
  grafana: EndpointInfo;
  prometheus: EndpointInfo;
  loki: EndpointInfo;
  authMode: string;
  oidcIssuer: string;
  oidcJwksUri: string;
  oidcAudience: string;
  /** Public OIDC client ID consumed by the dashboard (flui-web-config ConfigMap). */
  oidcClientId: string;
  oidcCliClientId: string;
}

interface AppSpec {
  defaultSubdomain: string | null;
  defaultScheme: 'http' | 'https';
  ingressNames: string[];
  ingressLabelNames: string[];
}

const SYSTEM_APPS: Record<SystemAppKey, AppSpec> = {
  fluiApi: {
    defaultSubdomain: 'api',
    defaultScheme: 'http',
    ingressNames: ['flui-api', 'flui-api-ingress'],
    ingressLabelNames: ['flui-api'],
  },
  fluiWeb: {
    defaultSubdomain: 'app',
    defaultScheme: 'http',
    ingressNames: ['flui-web', 'flui-web-ingress'],
    ingressLabelNames: ['flui-web'],
  },
  zitadel: {
    defaultSubdomain: 'auth',
    defaultScheme: 'https',
    ingressNames: ['zitadel', 'zitadel-ingress'],
    ingressLabelNames: ['zitadel'],
  },
  grafana: {
    defaultSubdomain: null,
    defaultScheme: 'http',
    ingressNames: ['grafana-ingress'],
    ingressLabelNames: ['grafana'],
  },
  prometheus: {
    defaultSubdomain: null,
    defaultScheme: 'http',
    ingressNames: ['prometheus-ingress'],
    ingressLabelNames: ['prometheus'],
  },
  loki: {
    defaultSubdomain: null,
    defaultScheme: 'http',
    ingressNames: ['loki-ingress'],
    ingressLabelNames: ['loki'],
  },
};

interface IngressResource {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    rules?: Array<{ host?: string }>;
    tls?: Array<{ hosts?: string[] }>;
  };
}

interface IngressRouteResource {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
  };
  spec?: {
    entryPoints?: string[];
    tls?: Record<string, unknown> | null;
    routes?: Array<{ match?: string }>;
  };
}

interface RouteMatch {
  host: string;
  scheme: 'http' | 'https';
}

interface RemoteSnapshot {
  ingresses: { items?: IngressResource[] };
  ingressRoutes: { items?: IngressRouteResource[] };
  configmap: { data?: Record<string, string> } | null;
  secret: { data?: Record<string, string> } | null;
  webConfigMap: { data?: Record<string, string> } | null;
  // Live OIDC from the running flui-api — authoritative over the frozen
  // ConfigMap/Secret, which k3s auto-deploy resets to empty.
  authConfig?: {
    authMode?: string;
    issuer?: string;
    clientId?: string;
    cliClientId?: string;
  } | null;
}

@Injectable()
export class CliEndpointResolverService {
  private readonly logger = new Logger(CliEndpointResolverService.name);

  constructor(private readonly sshService: CliSshService) {}

  async resolveEndpoints(
    masterIp: string,
    nipHostnameToken?: string | null,
  ): Promise<SystemEndpoints> {
    const snapshot = await this.fetchSnapshot(masterIp);

    const configMapData = snapshot.configmap?.data ?? {};
    const secretData = snapshot.secret?.data ?? {};

    const live = snapshot.authConfig ?? {};
    const pick = (...vals: (string | undefined)[]): string =>
      vals.find((v) => typeof v === 'string' && v.trim() !== '')?.trim() ?? '';

    const frozenAudience = secretData['OIDC_AUDIENCE']
      ? Buffer.from(secretData['OIDC_AUDIENCE'], 'base64').toString('utf-8')
      : '';
    let frozenClientId = '';
    const webConfigJson = snapshot.webConfigMap?.data?.['config.json'];
    if (webConfigJson) {
      try {
        const parsed = JSON.parse(webConfigJson) as Record<string, unknown>;
        if (typeof parsed.oidcClientId === 'string') {
          frozenClientId = parsed.oidcClientId;
        }
      } catch (err) {
        this.logger.warn(
          `flui-web-config/config.json is not valid JSON: ${(err as Error).message}`,
        );
      }
    }

    // Prefer the live values; fall back to the frozen ConfigMap/Secret only if
    // the API was unreachable (k3s auto-deploy resets the frozen ones).
    const authMode = pick(live.authMode, configMapData['AUTH_MODE'], 'unknown');
    const oidcIssuer = pick(live.issuer, configMapData['OIDC_ISSUER']);
    const oidcJwksUri = configMapData['OIDC_JWKS_URI'] ?? '';
    const oidcCliClientId = pick(
      live.cliClientId,
      configMapData['OIDC_CLI_CLIENT_ID'],
    );
    const oidcClientId = pick(live.clientId, frozenClientId);
    // audience = web client id
    const oidcAudience = pick(live.clientId, frozenAudience);

    const endpoints = {} as Record<SystemAppKey, EndpointInfo>;
    for (const key of Object.keys(SYSTEM_APPS) as SystemAppKey[]) {
      endpoints[key] = this.resolveApp(
        key,
        SYSTEM_APPS[key],
        snapshot.ingresses.items ?? [],
        snapshot.ingressRoutes.items ?? [],
        masterIp,
        nipHostnameToken,
      );
    }

    return {
      ...endpoints,
      authMode,
      oidcIssuer,
      oidcJwksUri,
      oidcAudience,
      oidcClientId,
      oidcCliClientId,
    };
  }

  private async fetchSnapshot(masterIp: string): Promise<RemoteSnapshot> {
    const command = [
      `ING=$(kubectl get ingress -n flui-system -o json 2>/dev/null || echo '{"items":[]}')`,
      `IR=$(kubectl get ingressroute.traefik.io -n flui-system -o json 2>/dev/null || echo '{"items":[]}')`,
      `CM=$(kubectl get configmap flui-api-config -n flui-system -o json 2>/dev/null || echo '{}')`,
      `SEC=$(kubectl get secret flui-secrets -n flui-system -o json 2>/dev/null || echo '{}')`,
      `WCM=$(kubectl get configmap flui-web-config -n flui-system -o json 2>/dev/null || echo '{}')`,
      `AIP=$(kubectl get svc flui-api -n flui-system -o jsonpath='{.spec.clusterIP}' 2>/dev/null)`,
      `APT=$(kubectl get svc flui-api -n flui-system -o jsonpath='{.spec.ports[0].port}' 2>/dev/null)`,
      `AC=$(curl -s --max-time 5 "http://$AIP:$APT/api/v1/auth/config" 2>/dev/null || echo '{}')`,
      `printf '{"ingresses":%s,"ingressRoutes":%s,"configmap":%s,"secret":%s,"webConfigMap":%s,"authConfig":%s}' "$ING" "$IR" "$CM" "$SEC" "$WCM" "$AC"`,
    ].join('; ');

    const output = await this.sshService.sshExec(masterIp, command);

    try {
      return JSON.parse(output);
    } catch (err) {
      this.logger.error(`Failed to parse kubectl snapshot: ${err.message}`);
      throw new Error(
        `Cannot parse cluster state from master (${masterIp}). Output was not valid JSON.`,
      );
    }
  }

  private resolveApp(
    key: SystemAppKey,
    spec: AppSpec,
    ingresses: IngressResource[],
    ingressRoutes: IngressRouteResource[],
    masterIp: string,
    nipHostnameToken?: string | null,
  ): EndpointInfo {
    // Prefer the k8s native Ingress over Traefik IngressRoute when both exist:
    // `configure-system-ingress` writes Ingress with the user-chosen domain
    // (e.g. *.flui.cloud), while the legacy IngressRoute may still carry
    // the nip.io hostname seeded at cluster bootstrap.
    const match =
      this.findIngressMatch(spec, ingresses) ??
      this.findIngressRouteMatch(spec, ingressRoutes);

    const baseDomain = buildNipBaseDomain(masterIp, nipHostnameToken);
    const defaultFqdn = spec.defaultSubdomain
      ? `${spec.defaultSubdomain}.${baseDomain}`
      : null;
    const defaultUrl = defaultFqdn
      ? `${spec.defaultScheme}://${defaultFqdn}`
      : '';

    if (match) {
      return {
        fqdn: match.host,
        defaultUrl,
        effectiveUrl: `${match.scheme}://${match.host}`,
        synced: true,
      };
    }

    return {
      fqdn: defaultFqdn,
      defaultUrl,
      effectiveUrl: defaultUrl,
      synced: !!defaultFqdn,
    };
  }

  private findIngressMatch(
    spec: AppSpec,
    ingresses: IngressResource[],
  ): RouteMatch | null {
    for (const ingress of ingresses) {
      const name = ingress.metadata?.name ?? '';
      const labelName =
        ingress.metadata?.labels?.['app.kubernetes.io/name'] ??
        ingress.metadata?.labels?.['app'] ??
        '';

      const matchesName = spec.ingressNames.includes(name);
      const matchesLabel = spec.ingressLabelNames.includes(labelName);

      if (!matchesName && !matchesLabel) continue;

      const host = ingress.spec?.rules?.find((r) => r.host)?.host;
      if (!host) continue;

      const tlsHosts = new Set<string>(
        (ingress.spec?.tls ?? []).flatMap((t) => t.hosts ?? []),
      );
      const scheme: 'http' | 'https' = tlsHosts.has(host) ? 'https' : 'http';
      return { host, scheme };
    }
    return null;
  }

  private findIngressRouteMatch(
    spec: AppSpec,
    routes: IngressRouteResource[],
  ): RouteMatch | null {
    for (const route of routes) {
      const name = route.metadata?.name ?? '';
      const labelName =
        route.metadata?.labels?.['app.kubernetes.io/name'] ??
        route.metadata?.labels?.['app'] ??
        '';

      const matchesName = spec.ingressNames.includes(name);
      const matchesLabel = spec.ingressLabelNames.includes(labelName);

      if (!matchesName && !matchesLabel) continue;

      const host = this.extractHostFromIngressRoute(route);
      if (!host) continue;

      const entryPoints = route.spec?.entryPoints ?? [];
      const hasTls = !!route.spec?.tls;
      const isSecure = hasTls || entryPoints.includes('websecure');
      const scheme: 'http' | 'https' = isSecure ? 'https' : 'http';
      return { host, scheme };
    }
    return null;
  }

  private extractHostFromIngressRoute(
    route: IngressRouteResource,
  ): string | null {
    const hostRe = /Host\(\s*`([^`]+)`/;
    for (const r of route.spec?.routes ?? []) {
      const m = hostRe.exec(r.match ?? '');
      if (m) return m[1];
    }
    return null;
  }
}

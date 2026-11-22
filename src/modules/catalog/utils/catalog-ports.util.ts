import {
  APP_UDP_PORT_MAX,
  APP_UDP_PORT_MIN,
  AppServicePort,
  AppUdpPort,
  isAppUdpPort,
} from '../../../common/net/public-udp';
import {
  CatalogPort,
  CatalogSpec,
} from '../interfaces/catalog-manifest.interface';

/** Every public UDP port an install of this spec would publish, across its components. */
export function udpPortsOfSpec(spec: CatalogSpec): AppUdpPort[] {
  if ('components' in spec && Array.isArray(spec.components)) {
    return spec.components.flatMap((c) => c.udpPorts ?? []);
  }
  return ('udpPorts' in spec ? spec.udpPorts : undefined) ?? [];
}

const PORT_NAME = /^[a-z][a-z0-9-]{0,14}$/;

/**
 * The ports a catalog entry declares after its main one, served on the same
 * in-cluster address: without them a second port, such as ClickHouse's native
 * protocol, has no address inside the cluster.
 */
export function extraServicePorts(
  ports: CatalogPort[] | undefined,
): AppServicePort[] | null {
  const main = ports?.[0]?.internal;
  const seen = new Set<number>(main ? [main] : []);
  const extra: AppServicePort[] = [];
  for (const p of (ports ?? []).slice(1)) {
    if (!PORT_NAME.test(p.name) || seen.has(p.internal)) continue;
    seen.add(p.internal);
    extra.push({ name: p.name, port: p.internal });
  }
  return extra.length ? extra : null;
}

/** What is wrong with the UDP ports a manifest declares, if anything. */
export function udpPortProblems(spec: Record<string, unknown>): string[] {
  const owners: Array<{ path: string; value: unknown }> = [];
  if ('udpPorts' in spec) owners.push({ path: 'spec', value: spec.udpPorts });
  if (Array.isArray(spec.components)) {
    spec.components.forEach((c: { udpPorts?: unknown }, i) => {
      if (c && 'udpPorts' in c) {
        owners.push({ path: `spec.components[${i}]`, value: c.udpPorts });
      }
    });
  }
  const problems: string[] = [];
  const seen = new Set<number>();
  for (const { path, value } of owners) {
    if (!Array.isArray(value)) {
      problems.push(`${path}.udpPorts must be a list`);
      continue;
    }
    value.forEach((p: { name?: unknown; port?: unknown }, i) => {
      const at = `${path}.udpPorts[${i}]`;
      if (typeof p?.name !== 'string' || !PORT_NAME.test(p.name)) {
        problems.push(
          `${at}.name must be a lowercase name of up to 15 characters`,
        );
      }
      if (typeof p?.port !== 'number' || !isAppUdpPort(p.port)) {
        problems.push(
          `${at}.port must be between ${APP_UDP_PORT_MIN} and ${APP_UDP_PORT_MAX}`,
        );
      } else if (seen.has(p.port)) {
        problems.push(`${at}.port ${p.port} is declared twice`);
      } else {
        seen.add(p.port);
      }
    });
  }
  return problems;
}

/** One internal host a workload's configuration names; never the value it came from. */
export interface WorkloadReference {
  name: string;
  namespace: string;
  port: number | null;
}

const URL_HOST =
  /\b[a-z][a-z0-9+.-]{0,30}:\/\/([a-z0-9.-]{1,253})(?::(\d{2,5}))?/gi;
const HOST_PORT = /(?:^|[\s,;=@"'(])([a-z0-9][a-z0-9.-]*):(\d{2,5})\b/gi;
const HOST_KEY = /(?:^|_)(HOST|HOSTNAME|ADDR|ADDRESS|SERVER)$/i;
const BARE_HOST = /^[a-z0-9][a-z0-9.-]*$/i;
/** `nc [-z] host port`, the usual way an init container waits for a dependency. */
const NC_WAIT = /\bnc\s+(?:-[a-z]+\s+)*([a-z0-9][a-z0-9.-]*)\s+(\d{2,5})\b/gi;

/**
 * The in-cluster hosts a set of configuration entries points at: URLs,
 * `host:port`, and bare hosts under a *_HOST-like key (their port taken from the
 * matching *_PORT key). A host is `name`, `name.namespace` or
 * `name.namespace.svc[.cluster.local]`; anything longer is outside the cluster.
 */
export function workloadReferences(
  entries: { key: string; value: string }[],
  ownNamespace: string,
): WorkloadReference[] {
  const byKey = new Map(entries.map((e) => [e.key.toUpperCase(), e.value]));
  const found = new Map<string, WorkloadReference>();
  const add = (host: string, port: string | number | null | undefined) => {
    const ref = hostToReference(host.toLowerCase(), ownNamespace);
    if (!ref) return;
    const parsed =
      port === null || port === undefined || port === '' ? null : Number(port);
    ref.port = Number.isInteger(parsed) ? parsed : null;
    const key = `${ref.namespace}/${ref.name}`;
    if (!found.has(key) || (found.get(key)!.port === null && ref.port !== null))
      found.set(key, ref);
  };
  for (const { key, value } of entries) {
    if (!value) continue;
    for (const m of value.matchAll(URL_HOST)) add(m[1], m[2]);
    for (const m of value.matchAll(HOST_PORT)) add(m[1], m[2]);
    for (const m of value.matchAll(NC_WAIT)) add(m[1], m[2]);
    const hostKey = HOST_KEY.exec(key);
    if (hostKey && BARE_HOST.test(value.trim())) {
      const portKey = key.slice(0, key.length - hostKey[1].length) + 'PORT';
      add(value.trim(), byKey.get(portKey.toUpperCase()));
    }
  }
  return [...found.values()];
}

function hostToReference(
  host: string,
  ownNamespace: string,
): WorkloadReference | null {
  const parts = host.replace(/\.$/, '').split('.');
  if (parts.length === 1)
    return { name: parts[0], namespace: ownNamespace, port: null };
  const inCluster =
    parts.length === 2 ||
    (parts[2] === 'svc' &&
      (parts.length === 3 || parts.slice(3).join('.') === 'cluster.local'));
  return inCluster ? { name: parts[0], namespace: parts[1], port: null } : null;
}

/** The workload a service name most likely fronts: the same name, or the name without a `-svc` suffix. */
export function workloadNamesFor(service: string): string[] {
  return service.endsWith('-svc') ? [service, service.slice(0, -4)] : [service];
}

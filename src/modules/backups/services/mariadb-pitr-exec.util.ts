import { BadRequestException } from '@nestjs/common';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  MariadbTarget,
  SHIPPER_CONFIG_POLL_MS,
  SHIPPER_CONFIG_WAIT_MS,
  SHIPPER_CONTAINER,
} from './mariadb-pitr.util';
import {
  NO_SHIPPER_FOR_BASE,
  RepositoryListing,
  SHIPPER_CONFIG_LATE,
  SHIPPER_CONFIG_PROBE_SCRIPT,
  SHIPPER_FEATURES_SCRIPT,
  ShippingState,
  listRepositoryScript,
  parseRepositoryListing,
  parseShipperFeatures,
  shippedEdgeScript,
  shippedEdgeWithinTolerance,
  shipperConfigMatches,
} from './mariadb-pitr-scripts.util';

export type MariadbPods = Pick<
  KubernetesService,
  'execInPod' | 'listResourcesByLabel'
>;

/**
 * Runs a script in the shipper rather than the database.
 *
 * Asks the pod spec whether the shipper is there before trying, rather than
 * reading the failure afterwards: an exec into a container that does not
 * exist fails on the websocket upgrade, and what reaches this catch may be
 * the API server's `container X is not valid for pod Y` or a bare `400`
 * depending on how far the transport got. A scheduled base backup can arrive
 * here long after the policy was created, on an application that has since
 * been redeployed without one.
 */
export async function execInShipper(
  k8s: MariadbPods,
  target: MariadbTarget,
  script: string,
): Promise<string> {
  if ((await shipperPresent(k8s, target)) === false) {
    throw new BadRequestException(NO_SHIPPER_FOR_BASE);
  }
  const b64 = Buffer.from(script, 'utf-8').toString('base64');
  return k8s.execInPod(
    target.kubeconfig,
    target.namespace,
    target.labelSelector,
    SHIPPER_CONTAINER,
    // `bash`, not `sh`: the image's /bin/sh is dash, which rejects
    // `set -o pipefail` outright — the script would die on its first line
    // and every command after it would silently not run.
    ['bash', '-c', `echo ${b64} | base64 -d | bash`],
  );
}

export async function execInDatabase(
  k8s: MariadbPods,
  target: MariadbTarget,
  script: string,
): Promise<string> {
  const b64 = Buffer.from(script, 'utf-8').toString('base64');
  return k8s.execInPod(
    target.kubeconfig,
    target.namespace,
    target.labelSelector,
    target.container,
    ['sh', '-c', `echo ${b64} | base64 -d | sh`],
  );
}

export function mariadbTargetFor(
  app: ApplicationEntity,
  kubeconfig: string,
): MariadbTarget {
  const envValue = (name: string) =>
    app.env?.find((e) => e.name === name)?.value;
  return {
    kubeconfig,
    namespace: app.k8sNamespace,
    labelSelector: `flui-app-id=${app.id}`,
    container: app.slug,
    host: '127.0.0.1',
    port: 3306,
    rootPasswordVar: 'MARIADB_ROOT_PASSWORD',
    user: envValue('MARIADB_USER') ?? 'root',
    database: envValue('MARIADB_DATABASE') ?? 'mysql',
  };
}

/** A `mariadb` invocation that authenticates from the container's own env. */
export function mariadbClient(target: MariadbTarget): string {
  return `mariadb -uroot -p"$${target.rootPasswordVar}" -N -B`;
}

export async function queryDatabase(
  k8s: MariadbPods,
  target: MariadbTarget,
  sql: string,
): Promise<string | undefined> {
  try {
    const out = await execInDatabase(
      k8s,
      target,
      `${mariadbClient(target)} -e ${JSON.stringify(sql)}`,
    );
    return out.trim().split('\n').pop()?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Is the shipper alongside this database, read from the pod's own spec?
 *
 * From the spec rather than from a failed exec into it, because an exec into
 * a container that does not exist fails on the websocket upgrade — the API
 * server answers `container X is not valid for pod Y`, which no amount of
 * pattern-matching turns into a reliable signal, and the transport can turn
 * it into a bare `400` before the body is ever read.
 *
 * `undefined` when no pod could be listed, which is not the same as "no
 * shipper": `listResourcesByLabel` returns `[]` for an unreachable cluster
 * too, and refusing a database because its cluster was briefly unreachable
 * would be a refusal for the wrong reason.
 */
export async function shipperPresent(
  k8s: MariadbPods,
  target: MariadbTarget,
): Promise<boolean | undefined> {
  const pods = await k8s.listResourcesByLabel(
    target.kubeconfig,
    'Pod',
    target.namespace,
    target.labelSelector,
  );
  if (!pods.length) return undefined;
  return pods.some((pod: any) =>
    (pod?.spec?.containers ?? []).some(
      (c: any) => c?.name === SHIPPER_CONTAINER,
    ),
  );
}

/**
 * Wait until the shipper can actually see its destination.
 *
 * Not in `enable()`: the request that turns a policy on is synchronous and
 * the CLI gives it thirty seconds, while a mounted Secret takes about a
 * minute to appear. The first base backup is the right place to wait,
 * because it is the step that needs the file — and `enable` and
 * `recoverable` only become the same moment once it has run.
 */
export async function awaitShipperConfig(
  k8s: MariadbPods,
  target: MariadbTarget,
  state: ShippingState | undefined,
): Promise<void> {
  const deadline = Date.now() + SHIPPER_CONFIG_WAIT_MS;
  for (;;) {
    if (await shipperConfigCurrent(k8s, target, state)) return;
    if (Date.now() > deadline) {
      throw new BadRequestException(SHIPPER_CONFIG_LATE);
    }
    await new Promise((r) => setTimeout(r, SHIPPER_CONFIG_POLL_MS));
  }
}

/**
 * The mounted file lags the Secret by a kubelet sync: a base taken, or a
 * repository listed, before it turns over would use the previous
 * configuration.
 */
export async function shipperConfigCurrent(
  k8s: MariadbPods,
  target: MariadbTarget,
  state: ShippingState | undefined,
): Promise<boolean> {
  const seen = await execInShipper(
    k8s,
    target,
    SHIPPER_CONFIG_PROBE_SCRIPT,
  ).catch(() => '');
  return shipperConfigMatches(seen, state);
}

/**
 * What the shipper image can do: read and write through `flui_crypt`, and
 * compress with zstd. An image built before either has no such line, and
 * keeps shipping the way it always did rather than be handed a remote it
 * cannot open or a setting it would silently ignore.
 */
export async function shipperFeatures(
  k8s: MariadbPods,
  target: MariadbTarget,
): Promise<Set<string>> {
  const features = parseShipperFeatures(
    await execInShipper(k8s, target, SHIPPER_FEATURES_SCRIPT),
  );
  if (!features) {
    throw new BadRequestException(
      'Could not ask the backup shipper what it supports; nothing was changed.',
    );
  }
  return features;
}

export async function shippedEdgeCurrent(
  k8s: MariadbPods,
  target: MariadbTarget,
): Promise<boolean> {
  const out = await execInShipper(
    k8s,
    target,
    shippedEdgeScript(target.host, target.port),
  ).catch(() => '');
  return shippedEdgeWithinTolerance(out);
}

export async function listRepository(
  k8s: MariadbPods,
  target: MariadbTarget,
): Promise<RepositoryListing> {
  const out = await execInShipper(k8s, target, listRepositoryScript()).catch(
    () => '',
  );
  return parseRepositoryListing(out);
}

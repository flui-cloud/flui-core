import { loadAll } from 'js-yaml';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';

/** What an application's own manifests may create: namespaced kinds only. */
export const APP_SCOPED_KINDS: ReadonlySet<string> = new Set([
  ApplicationResourceKind.DEPLOYMENT,
  ApplicationResourceKind.STATEFUL_SET,
  ApplicationResourceKind.DAEMON_SET,
  ApplicationResourceKind.SERVICE,
  ApplicationResourceKind.INGRESS,
  ApplicationResourceKind.INGRESS_ROUTE,
  ApplicationResourceKind.CONFIG_MAP,
  ApplicationResourceKind.SECRET,
  ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
  ApplicationResourceKind.HORIZONTAL_POD_AUTOSCALER,
  ApplicationResourceKind.CERTIFICATE,
  ApplicationResourceKind.JOB,
  ApplicationResourceKind.CRON_JOB,
]);

interface ManifestDocument {
  kind?: unknown;
  metadata?: { namespace?: unknown; name?: unknown };
}

/**
 * Why a manifest rendered for an application cannot be applied, or null when
 * every document stays inside the application's namespace and is one of the
 * kinds an application owns. Applied with the cluster's admin credentials, so
 * anything else is refused whatever produced it.
 */
export function appManifestRefusal(
  documents: unknown[],
  namespace: string,
): string | null {
  const present = documents.filter(
    (doc): doc is ManifestDocument =>
      !!doc && typeof doc === 'object' && Object.keys(doc).length > 0,
  );
  if (!present.length) return 'the manifest is empty';
  for (const doc of present) {
    const kind = typeof doc.kind === 'string' ? doc.kind : '(none)';
    if (!APP_SCOPED_KINDS.has(kind)) {
      return `an application cannot create a ${kind}`;
    }
    if (doc.metadata?.namespace !== namespace) {
      const name =
        typeof doc.metadata?.name === 'string' ? doc.metadata.name : '';
      return `${kind} ${name} is not in the application's namespace`;
    }
  }
  return null;
}

/** Applies an application's manifest only after `appManifestRefusal` lets every document through. */
export async function applyAppManifest(
  kubernetes: {
    applyManifest(kubeconfig: string, yaml: string): Promise<unknown>;
  },
  kubeconfig: string,
  yaml: string,
  namespace: string,
): Promise<void> {
  const refused = appManifestRefusal(loadAll(yaml), namespace);
  if (refused) {
    throw new Error(`Refused to apply the application's manifest: ${refused}`);
  }
  await kubernetes.applyManifest(kubeconfig, yaml);
}

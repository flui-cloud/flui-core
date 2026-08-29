/**
 * What only this installation can tell an author about their manifest.
 *
 * The schema answers whether the file is well-formed; every one of these
 * answers whether it would *work here* — on this cluster, with these
 * credentials, against what is already deployed. An agent that has never seen
 * Flui can satisfy the schema on the first try and still write a manifest that
 * fails eight minutes into a build, and the difference between the two is
 * exactly this list.
 *
 * `unknown` is a first-class outcome and never collapses into `fail`. A cluster
 * that could not be read has not refused anything, and telling an author their
 * manifest is wrong because we could not look is worse than saying nothing.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface ManifestCheck {
  id: string;
  status: CheckStatus;
  title: string;
  /** The whole of the answer, in the words the author needs to act on. */
  detail: string;
}

export interface CapacityFact {
  fits: boolean;
  requiredCpuMc: number;
  requiredMemoryMi: number;
  availableCpuMc: number | null;
  availableMemoryMi: number | null;
}

export interface ManifestFacts {
  clusterFound: boolean;
  /** Null when the cluster could not be read at all — not the same as "not ready". */
  clusterReady: boolean | null;
  clusterName: string | null;
  /** Null when no repository was named, so nothing was asked. */
  repositoryConnected: boolean | null;
  repoFullName: string | null;
  githubConnected: boolean | null;
  /** A registry credential the build can push with. */
  registryCredential: boolean | null;
  /** The application this manifest would update, if one already answers to its identity. */
  existingApp: string | null;
  capacity: CapacityFact | null;
  exposure: 'public' | 'internal';
  /** A DNS zone bound to this cluster, or null when applications answer on the default host. */
  dnsZone: string | null;
  /** An explicit hostname the manifest asks for. */
  fqdn: string | null;
  /** Whether the target is the installation's own control cluster. */
  targetIsControlCluster: boolean;
  /** Whether this installation has any workload cluster at all. */
  hasWorkloadCluster: boolean | null;
}

const check = (
  id: string,
  status: CheckStatus,
  title: string,
  detail: string,
): ManifestCheck => ({ id, status, title, detail });

export function checksFor(facts: ManifestFacts): ManifestCheck[] {
  return [
    clusterCheck(facts),
    repositoryCheck(facts),
    registryCheck(facts),
    capacityCheck(facts),
    placementCheck(facts),
    identityCheck(facts),
    exposureCheck(facts),
  ];
}

/** True when nothing here would stop a deploy. Unknown never blocks. */
export function wouldDeploy(checks: ManifestCheck[]): boolean {
  return !checks.some((c) => c.status === 'fail');
}

function clusterCheck(facts: ManifestFacts): ManifestCheck {
  if (!facts.clusterFound) {
    return check(
      'cluster',
      'fail',
      'Target cluster',
      'No cluster answers to that id in this installation. Deploying needs one that does.',
    );
  }
  if (facts.clusterReady === null) {
    return check(
      'cluster',
      'unknown',
      'Target cluster',
      `${facts.clusterName ?? 'The cluster'} could not be read just now, so whether it can take a deploy is unanswered — not refused.`,
    );
  }
  return facts.clusterReady
    ? check(
        'cluster',
        'pass',
        'Target cluster',
        `${facts.clusterName ?? 'The cluster'} is ready.`,
      )
    : check(
        'cluster',
        'fail',
        'Target cluster',
        `${facts.clusterName ?? 'The cluster'} is not in a state that can take a deploy.`,
      );
}

function repositoryCheck(facts: ManifestFacts): ManifestCheck {
  if (facts.repositoryConnected === null) {
    return check(
      'repository',
      'unknown',
      'Source repository',
      'No repository was named, so nothing was checked. A manifest deploy builds from a connected repository.',
    );
  }
  if (!facts.repositoryConnected) {
    return check(
      'repository',
      'fail',
      'Source repository',
      `${facts.repoFullName} is not connected to this account. Connect it from the dashboard or with \`flui repo connect\` — the build reads the code from there, not from the manifest.`,
    );
  }
  return check(
    'repository',
    'pass',
    'Source repository',
    `${facts.repoFullName} is connected.`,
  );
}

/**
 * The build pushes an image somewhere and the cluster pulls it back. Both halves
 * are credentials nobody thinks about until a build has already run for minutes
 * and fails at the last step.
 */
function registryCheck(facts: ManifestFacts): ManifestCheck {
  if (facts.githubConnected === null && facts.registryCredential === null) {
    return check(
      'registry',
      'unknown',
      'Build and registry',
      'Neither the GitHub connection nor the registry credential could be read.',
    );
  }
  const missing: string[] = [];
  if (facts.githubConnected === false) missing.push('the GitHub connection');
  if (facts.registryCredential === false)
    missing.push('a registry credential to push the image with');
  if (missing.length) {
    return check(
      'registry',
      'fail',
      'Build and registry',
      `This deploy needs ${missing.join(' and ')}. The manifest is fine; the account is not ready to build it.`,
    );
  }
  return check(
    'registry',
    'pass',
    'Build and registry',
    'GitHub is connected and a registry credential is in place.',
  );
}

function capacityCheck(facts: ManifestFacts): ManifestCheck {
  const cap = facts.capacity;
  if (!cap) {
    return check(
      'capacity',
      'unknown',
      'Room on the cluster',
      'Live capacity could not be read, so whether this fits is unanswered. It is not a refusal.',
    );
  }
  const asked = `${cap.requiredCpuMc}m CPU and ${cap.requiredMemoryMi}Mi`;
  if (cap.fits) {
    return check(
      'capacity',
      'pass',
      'Room on the cluster',
      `${asked} fit what the cluster has free.`,
    );
  }
  const free =
    cap.availableCpuMc === null || cap.availableMemoryMi === null
      ? 'less than that'
      : `${cap.availableCpuMc}m CPU and ${cap.availableMemoryMi}Mi`;
  return check(
    'capacity',
    'fail',
    'Room on the cluster',
    `This asks for ${asked} and the cluster has ${free} free. Lower deploy.resources, or add a node.`,
  );
}

/**
 * Deploying onto the control cluster is allowed, and says so.
 *
 * It is how a single-machine installation works — there is one cluster, and
 * refusing it would leave the product with nothing to deploy to on the shape
 * most people start with. What it costs is isolation: an application that
 * exhausts the node takes the API, the dashboard and the identity server with
 * it. So this is a `warn` with a reason, never a `fail`, and it goes quiet the
 * moment a workload cluster exists to say it against.
 */
function placementCheck(facts: ManifestFacts): ManifestCheck {
  if (!facts.targetIsControlCluster) {
    return check(
      'placement',
      'pass',
      'Where it lands',
      'A workload cluster, kept apart from the control plane.',
    );
  }
  return check(
    'placement',
    'warn',
    'Where it lands',
    facts.hasWorkloadCluster
      ? 'This deploys onto the control cluster, which also runs the API, the dashboard and identity — and this installation has a workload cluster that would keep them apart. Supported, but the isolation is being given up by choice.'
      : 'This deploys onto the control cluster, which also runs the API, the dashboard and identity. Supported, and the normal shape for a single-machine installation — but an application that exhausts the node takes the control plane with it. A workload cluster is the recommended shape once there is more than one thing running.',
  );
}

/**
 * Named rather than silent: a manifest deploy is keyed on (cluster, repository,
 * branch, name), so an author who reuses a name is updating an application
 * rather than creating one — which is the right behaviour and the wrong
 * surprise.
 */
function identityCheck(facts: ManifestFacts): ManifestCheck {
  return facts.existingApp
    ? check(
        'identity',
        'warn',
        'What this deploy does',
        `An application already answers to this identity (${facts.existingApp}). This updates it rather than creating a new one — rename metadata.name if a second application was intended.`,
      )
    : check(
        'identity',
        'pass',
        'What this deploy does',
        'Nothing here answers to this identity yet, so this creates a new application.',
      );
}

function exposureCheck(facts: ManifestFacts): ManifestCheck {
  if (facts.exposure === 'internal') {
    return check(
      'exposure',
      'pass',
      'How it is reached',
      'Internal: reachable inside the cluster and from the dashboard, with no public hostname.',
    );
  }
  if (facts.fqdn && !facts.dnsZone) {
    return check(
      'exposure',
      'warn',
      'How it is reached',
      `The manifest asks for ${facts.fqdn}, and this cluster has no DNS zone bound. The record has to exist already and point here, or the certificate will not be issued.`,
    );
  }
  return facts.dnsZone
    ? check(
        'exposure',
        'pass',
        'How it is reached',
        `Public, under ${facts.dnsZone}.`,
      )
    : check(
        'exposure',
        'warn',
        'How it is reached',
        'Public, but no DNS zone is bound to this cluster — it will answer on the default host rather than a name of yours.',
      );
}

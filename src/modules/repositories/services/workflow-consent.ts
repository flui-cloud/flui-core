import { WorkflowDelivery } from './github-workflow.service';

/**
 * What we are about to write into somebody else's repository, said in full
 * before we write it.
 *
 * The screen this feeds used to summarise: three bullet points, one of which
 * named a file we do not write any more. A summary is fine when the reader
 * already trusts the writer; it is not fine when the reader is a stranger who
 * arrived two minutes ago and is being asked to hand over commit access. So the
 * contract here is the opposite of a summary — every path we touch is named,
 * and the workflow body travels whole, never elided.
 */

export interface WorkflowWrite {
  /** Where it lands: a repository path, or a settings location. */
  target: string;
  /** What it is, in one line a person can check against the diff. */
  what: string;
}

export interface WorkflowConsent {
  /** `owner/repo`. */
  repository: string;
  branch: string;
  delivery: WorkflowDelivery;
  /** Why it lands the way it lands, for the person deciding. */
  deliveryNote: string;
  writes: WorkflowWrite[];
  /** The workflow body, entire. Never truncated, never summarised. */
  workflowYaml: string;
  /**
   * The repository secret the committed workflow reads for its webhook
   * credential. Null when backend polling strips the notify steps and no
   * secret is involved: naming one would point at a line the reader cannot
   * find in the body above.
   */
  webhookSecretName: string | null;
  /**
   * What that secret is, and what it is not, said before it is written. Null
   * alongside the name above.
   */
  webhookSecretNote: string | null;
  /** The build spends the repository owner's Actions minutes, not ours. */
  usesYourActionsMinutes: boolean;
  /** The constraint that makes the whole path defensible — see the plan's §3. */
  builtOnFluiMachines: boolean;
}

/**
 * Which branch the commit lands on.
 *
 * A guest never gets to choose: whatever the client asked for, a stranger on a
 * shared demo gets a pull request. Writing to their default branch is an
 * intrusion however loudly it was announced, and the client asking nicely for
 * `push` is not the repository owner's consent — it is our own interface
 * talking back to us.
 */
export function resolveWorkflowDelivery(input: {
  requested?: WorkflowDelivery;
  isSandboxGuest: boolean;
}): WorkflowDelivery {
  if (input.isSandboxGuest) return 'pull-request';
  return input.requested ?? 'push';
}

export function describeDelivery(
  delivery: WorkflowDelivery,
  branch: string,
): string {
  return delivery === 'pull-request'
    ? `Flui opens a pull request against ${branch}. Nothing runs and nothing changes until you merge it; closing it undoes the whole thing.`
    : `Flui commits directly to ${branch}. That commit is what starts the first build.`;
}

/**
 * The webhook credential used to be written into the committed file as text,
 * which meant anyone who could read the repository could make Flui deploy an
 * image of their choosing. It is a repository secret now — which is better, and
 * is not the same as private. Saying both is the point of this sentence.
 */
export function describeWebhookSecret(secretName: string): string {
  return `The file above contains no credentials. The build reports back by reading ${secretName} from this repository's secrets, which Flui writes just before it commits the workflow. GitHub stores it encrypted and Flui cannot read it back — but it is not hidden from everyone: anyone with write access to this repository, and any workflow that runs in it, can use it.`;
}

export function buildWorkflowConsent(input: {
  owner: string;
  repo: string;
  branch: string;
  delivery: WorkflowDelivery;
  workflowPath: string;
  workflowYaml: string;
  /**
   * Name of the repository secret carrying the webhook credential, or null
   * when the generated body calls no webhook.
   */
  webhookSecretName: string | null;
  /** Set when a GHCR credential is written into the repository's secrets. */
  writesGhcrSecret: boolean;
  ghcrSecretName: string;
  /** Named only when this app supersedes one, so the list stays truthful. */
  removesPath?: string;
}): WorkflowConsent {
  const writes: WorkflowWrite[] = [
    {
      target: input.workflowPath,
      what: 'The GitHub Actions workflow shown below, added to your repository.',
    },
  ];

  if (input.removesPath) {
    writes.push({
      target: input.removesPath,
      what: "Deleted in the same commit — it was this application's previous workflow and is superseded.",
    });
  }

  if (input.webhookSecretName) {
    writes.push({
      target: `Repository secret ${input.webhookSecretName}`,
      what: 'The credential the workflow uses to tell Flui the build finished, and the one Flui checks before it rolls out the image. Written before the commit, so the workflow never lands without it.',
    });
  }

  if (input.writesGhcrSecret) {
    writes.push({
      target: `Repository secret ${input.ghcrSecretName}`,
      what: 'A credential the workflow uses to push the built image to your own ghcr.io. Stored encrypted by GitHub; Flui cannot read it back.',
    });
  }

  return {
    repository: `${input.owner}/${input.repo}`,
    branch: input.branch,
    delivery: input.delivery,
    deliveryNote: describeDelivery(input.delivery, input.branch),
    writes,
    workflowYaml: input.workflowYaml,
    webhookSecretName: input.webhookSecretName,
    webhookSecretNote: input.webhookSecretName
      ? describeWebhookSecret(input.webhookSecretName)
      : null,
    usesYourActionsMinutes: true,
    builtOnFluiMachines: false,
  };
}

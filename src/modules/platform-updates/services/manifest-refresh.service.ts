import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  HeldFile,
  ManifestMasterService,
  BACKUP_DIR,
} from './manifest-master.service';
import { ReleaseManifestService } from './release-manifest.service';
import {
  BootstrapFilesService,
  MasterKind,
  ReleaseFiles,
} from './bootstrap-files.service';
import { InstallValuesService } from './install-values.service';
import { ValuesContext } from '../interfaces/install-values.interface';
import { RELEASE } from '../../../config/release.config';
import {
  Candidate,
  Judgement,
  judge,
  planDigest,
  renderedRelease,
  sha256,
} from '../utils/manifest-eligibility.util';
import {
  documentsOf,
  requiredSecretsOf,
  workloadsOf,
} from '../utils/manifest-documents.util';

/** Byte order, not locale order: the plan digest must not depend on the machine. */
const byName = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

export interface RefreshEntry extends Judgement {
  currentSha?: string;
  releaseSha?: string;
}

export interface RefreshPlan {
  ref: string;
  planId: string;
  clusterId: string;
  clusterType: MasterKind;
  entries: RefreshEntry[];
  /** Absent when the release ships no index, which disables adding. */
  indexed: boolean;
  /** Why templated files are not rendered, when they are not. */
  valuesUnavailable?: string;
}

export interface RefreshResult extends RefreshPlan {
  wrote: string[];
  backupPath: string;
}

interface RefreshOptions {
  ref?: string;
  /** Omitted means the control cluster. */
  clusterId?: string;
  only?: string[];
  allowStatefulImageChange?: boolean;
  allowOverwriteModified?: boolean;
}

interface PlanState {
  plan: RefreshPlan;
  kubeconfig: string;
  node: string;
  contents: Map<string, string>;
  secretSources: Map<string, string>;
}

interface EntryInputs {
  options: RefreshOptions;
  release: ReleaseFiles;
  onMaster: Map<string, HeldFile>;
  mayHoldSecret: ReadonlySet<string>;
  context: ValuesContext;
  secretVariables: ReadonlySet<string>;
  secretIndex: Map<string, string[]> | null;
  kubeconfig: string;
  secretExists: Map<string, boolean>;
  secretSources: Map<string, string>;
}

interface SecretSource {
  source?: string;
  missingKey?: string;
}

type SecretCheck = (location: string) => Promise<boolean>;

async function sourceAmong(
  ref: string,
  locations: string[],
  has: SecretCheck,
  holdsKey: SecretCheck,
): Promise<SecretSource> {
  const target = locations.find((l) => l.startsWith(`${ref}/`));
  if (!target) return {};
  let missingKey: string | undefined;
  for (const other of locations) {
    if (other === target) continue;
    const secret = other.split('/').slice(0, 2).join('/');
    if (secret === ref || !(await has(secret))) continue;
    if (await holdsKey(other)) return { source: `${other} ${target}` };
    missingKey = missingKey ?? other;
  }
  return { missingKey };
}

async function sourceFor(
  ref: string,
  secretIndex: Map<string, string[]> | null,
  has: SecretCheck,
  holdsKey: SecretCheck,
): Promise<SecretSource> {
  let missingKey: string | undefined;
  for (const locations of secretIndex?.values() ?? []) {
    const found = await sourceAmong(ref, locations, has, holdsKey);
    if (found.source) return found;
    missingKey = missingKey ?? found.missingKey;
  }
  return { missingKey };
}

/**
 * Bringing the manifests on a master into line with a release.
 *
 * A file no template reproduces was changed on the master and is left alone
 * unless overwriting it is asked for. A file a secret may have been rendered
 * into is judged on its digest, the images its workloads run and the
 * provenance the reader counted.
 *
 * A file needing no value is replaced as it ships. A templated file is
 * rendered only with values this installation recorded, and only once the
 * record is proven again against the master's current copies; image tags are
 * always the ones running. A file needing a secret value is left alone. The
 * destructive-change check runs whatever the file needs, values or none.
 */
@Injectable()
export class ManifestRefreshService {
  private readonly logger = new Logger(ManifestRefreshService.name);

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly master: ManifestMasterService,
    private readonly releases: ReleaseManifestService,
    private readonly files: BootstrapFilesService,
    private readonly installValues: InstallValuesService,
  ) {}

  /**
   * Does this ref name a release somebody published — the one this build pins,
   * or one in the release manifest, by its commit or by its `v<version>` tag?
   * No ref at all means the pinned release. An unreadable manifest narrows the
   * answer to the pinned release; it never widens it.
   */
  async isPublishedRef(ref?: string): Promise<boolean> {
    if (!ref) return true;
    const known = new Set([RELEASE.bootstrapRef, `v${RELEASE.version}`]);
    const manifest = await this.releases
      .getManifest()
      .then((m) => m.manifest.releases)
      .catch(() => []);
    for (const r of manifest) {
      known.add(r.bootstrapRef);
      known.add(`v${r.version}`);
    }
    return known.has(ref);
  }

  async plan(options: RefreshOptions): Promise<RefreshPlan> {
    return (await this.compute(options)).plan;
  }

  /**
   * Recomputed from scratch, then compared. A person can only apply what they
   * previewed, against the state they previewed it on — and because the digest
   * covers the rendered files and the values they were rendered with, a `--ref`
   * that moved between the two also fails, with no need to resolve it first.
   */
  async apply(
    options: RefreshOptions & { planId: string },
  ): Promise<RefreshResult> {
    const fresh = await this.compute(options);
    if (fresh.plan.planId !== options.planId) {
      // Typed exception so the message reaches the client; a plain Error becomes a 500.
      throw new ConflictException(
        `The plan changed since the dry run (${options.planId} → ${fresh.plan.planId}). Run it again and apply the plan id it prints.`,
      );
    }

    const writable = fresh.plan.entries.filter(
      (e) => e.action === 'replace' || e.action === 'add',
    );
    if (writable.length === 0) {
      return { ...fresh.plan, wrote: [], backupPath: '' };
    }

    for (const ref of new Set(
      writable.flatMap((e) => e.createsSecrets ?? []),
    )) {
      await this.createSecretFromSource(
        fresh.kubeconfig,
        ref,
        fresh.secretSources.get(ref) as string,
      );
    }

    const wrote = await this.master.write(
      fresh.kubeconfig,
      fresh.node,
      fresh.plan.planId,
      writable.map((e) => ({
        name: e.name,
        content: fresh.contents.get(e.name) as string,
        expectCurrentSha: e.currentSha,
      })),
    );
    return {
      ...fresh.plan,
      wrote,
      backupPath: `${BACKUP_DIR}/${fresh.plan.planId}`,
    };
  }

  private async compute(options: RefreshOptions): Promise<PlanState> {
    const ref = options.ref ?? RELEASE.bootstrapRef;
    const access = await this.installValues.masterAccess(options.clusterId);
    const { kubeconfig, node, cluster, kind } = access;
    const secretIndex = await this.files.secrets(ref);
    const secretVariables = new Set(secretIndex?.keys() ?? []);

    const proven = await this.installValues.readProven(access, {
      refs: [ref],
    });
    const onMaster = proven.files;
    let release: ReleaseFiles = await this.files.releaseFiles(ref, [], kind);
    if (!release.indexed) {
      release = await this.files.releaseFiles(ref, [...onMaster.keys()], kind);
    }
    const context = await this.installValues.valuesFor(
      kubeconfig,
      onMaster,
      [...release.files.values()].map((f) => f.template),
      secretVariables,
      kind,
    );

    const names = new Set<string>([
      ...release.files.keys(),
      ...onMaster.keys(),
    ]);
    const entries: RefreshEntry[] = [];
    const contents = new Map<string, string>();
    const secretSources = new Map<string, string>();
    const inputs: EntryInputs = {
      options,
      release,
      onMaster,
      mayHoldSecret: proven.mayHoldSecret,
      context,
      secretVariables,
      secretIndex,
      kubeconfig,
      secretExists: new Map<string, boolean>(),
      secretSources,
    };

    for (const name of [...names].sort(byName)) {
      if (options.only?.length && !options.only.includes(name)) continue;
      const { entry, content } = await this.planEntry(name, inputs);
      if (content !== undefined) contents.set(name, content);
      entries.push(entry);
    }

    return {
      plan: {
        ref,
        clusterId: cluster.id,
        clusterType: kind,
        indexed: release.indexed,
        planId: planDigest(ref, entries, `${context.digest}@${cluster.id}`),
        entries,
        ...(context.unavailable
          ? { valuesUnavailable: context.unavailable }
          : {}),
      },
      kubeconfig,
      node,
      contents,
      secretSources,
    };
  }

  private async planEntry(
    name: string,
    inputs: EntryInputs,
  ): Promise<{ entry: RefreshEntry; content?: string }> {
    const { options, release, context, secretVariables, kubeconfig } = inputs;
    const file = release.files.get(name);
    const held = inputs.onMaster.get(name);

    if (!file) {
      return {
        entry: {
          name,
          action: 'skip',
          reason: 'not in this release; left in place.',
          currentSha: held?.sha,
        },
      };
    }
    // A file the master holds but whose content we deliberately never read,
    // because it carries a Secret, must still be judged — on what we do know.
    if (
      held &&
      held.content === undefined &&
      !held.carriesSecret &&
      !held.withheld
    ) {
      return {
        entry: {
          name,
          action: 'skip',
          reason: 'the reader could not return this file.',
          currentSha: held.sha,
        },
      };
    }

    const candidate = this.candidateFor(
      name,
      file,
      held,
      release,
      context,
      secretVariables,
    );
    if (
      held &&
      !held.carriesSecret &&
      held.content === undefined &&
      !inputs.mayHoldSecret.has(name)
    ) {
      candidate.currentModified = true;
    }
    const content = renderedRelease(candidate);
    const docs = this.parses(content);
    if (held?.withheld && docs) {
      candidate.currentWithheld = {
        sha: held.sha,
        declaresProvenance: held.declaresProvenance ?? false,
        runningImages: await this.installValues.runningImages(
          kubeconfig,
          workloadsOf(docs),
        ),
      };
    }
    if (docs) {
      candidate.missingSecrets = await this.missingSecrets(
        kubeconfig,
        docs,
        inputs.secretIndex,
        inputs.secretExists,
        inputs.secretSources,
      );
    }

    const verdict = judge(candidate, {
      allowStatefulImageChange: options.allowStatefulImageChange,
      allowOverwriteModified: options.allowOverwriteModified,
    });
    const writes = verdict.action === 'replace' || verdict.action === 'add';
    return {
      entry: {
        ...verdict,
        currentSha: held?.sha,
        releaseSha: sha256(writes ? content : file.template),
      },
      ...(writes ? { content } : {}),
    };
  }

  private candidateFor(
    name: string,
    file: { set: string; template: string },
    held: HeldFile | undefined,
    release: ReleaseFiles,
    context: ValuesContext,
    secretVariables: ReadonlySet<string>,
  ): Candidate {
    const requires = release.requires?.get(name);
    return {
      name,
      release: file.template,
      current: held?.content,
      currentCarriesSecret: held?.carriesSecret,
      declaredByRelease: release.declared.has(name),
      ...(requires
        ? {
            requires: {
              variable: requires,
              recorded: context.flags?.has(requires) ?? false,
            },
          }
        : {}),
      raw:
        file.set === 'common' || (context.transforms.raw ?? []).includes(name),
      values: context.values,
      valuesUnavailable: context.unavailable,
      unproven: context.unproven,
      secretVariables,
      transforms: context.transforms,
    };
  }

  private parses(content: string): unknown[] | null {
    try {
      return documentsOf(content);
    } catch {
      return null;
    }
  }

  /**
   * Secrets a file's pods need that this installation lacks. One can be
   * created only by copying the same variable from another place the release
   * lists it — never from a value this command was given or holds itself.
   */
  private async missingSecrets(
    kubeconfig: string,
    docs: unknown[],
    secretIndex: Map<string, string[]> | null,
    exists: Map<string, boolean>,
    sources: Map<string, string>,
  ): Promise<Array<{ ref: string; derivable: boolean; missingKey?: string }>> {
    const keys = new Map<string, Set<string>>();
    const has = (ref: string) => this.secretExists(kubeconfig, exists, ref);
    const holdsKey = (location: string) =>
      this.secretHoldsKey(kubeconfig, keys, location);

    const out: Array<{ ref: string; derivable: boolean; missingKey?: string }> =
      [];
    for (const ref of requiredSecretsOf(docs)) {
      if (await has(ref)) continue;
      const { source, missingKey } = await sourceFor(
        ref,
        secretIndex,
        has,
        holdsKey,
      );
      if (source) sources.set(ref, source);
      out.push({
        ref,
        derivable: source !== undefined,
        ...(source === undefined && missingKey ? { missingKey } : {}),
      });
    }
    return out;
  }

  private async secretExists(
    kubeconfig: string,
    exists: Map<string, boolean>,
    ref: string,
  ): Promise<boolean> {
    if (!exists.has(ref)) {
      const [namespace, name] = ref.split('/');
      exists.set(
        ref,
        await this.kubernetesService
          .secretExists(kubeconfig, name, namespace)
          .catch(() => false),
      );
    }
    return exists.get(ref) as boolean;
  }

  private async secretHoldsKey(
    kubeconfig: string,
    keys: Map<string, Set<string>>,
    location: string,
  ): Promise<boolean> {
    const [namespace, name, key] = location.split('/');
    const secret = `${namespace}/${name}`;
    if (!keys.has(secret)) {
      const data = await this.kubernetesService
        .readSecretData(kubeconfig, name, namespace)
        .catch(() => null);
      keys.set(
        secret,
        new Set(
          Object.entries(data ?? {})
            .filter(([, v]) => typeof v === 'string' && v.length > 0)
            .map(([k]) => k),
        ),
      );
    }
    return keys.get(secret)?.has(key) ?? false;
  }

  private async createSecretFromSource(
    kubeconfig: string,
    ref: string,
    route: string,
  ): Promise<void> {
    const [from, to] = route.split(' ');
    const [fromNs, fromName, fromKey] = from.split('/');
    const [toNs, toName, toKey] = to.split('/');
    const data = await this.kubernetesService.readSecretData(
      kubeconfig,
      fromName,
      fromNs,
    );
    const value = data?.[fromKey];
    if (value === undefined) {
      throw new ConflictException(
        `${from} has no value to copy into ${ref}. Nothing was written.`,
      );
    }
    await this.kubernetesService.createObject(kubeconfig, {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: toName,
        namespace: toNs,
        labels: {
          'app.kubernetes.io/managed-by': 'flui-cloud',
          'flui.cloud/managed': 'true',
          'flui.cloud/scope': 'system',
          'flui.cloud/owner-kind': 'platform',
          'flui.cloud/owner-id': 'flui-core',
        },
      },
      data: { [toKey]: Buffer.from(value, 'utf8').toString('base64') },
    });
    this.logger.log(`Created Secret ${ref} from ${fromNs}/${fromName}`);
  }
}

export type { Action, Judgement } from '../utils/manifest-eligibility.util';

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  HeldFile,
  ManifestMasterService,
  WITHHELD_BY_HISTORY,
} from './manifest-master.service';
import { MasterKind } from './bootstrap-files.service';
import { InstallSourcesService } from './install-sources.service';
import { MasterAccessService } from './master-access.service';
import { InstallStateService } from './install-state.service';
import {
  InstallValuesPlan,
  InstallValuesResult,
  MasterAccess,
  ProvenRead,
  ValuesContext,
} from '../interfaces/install-values.interface';
import {
  imageTagSlots,
  proofDigest,
  proveInstallValues,
  secretBearingFiles,
} from '../utils/install-values.util';
import { placeholdersIn } from '../utils/manifest-render.util';
import {
  contextDigest,
  mostProvenRef,
  pinRunningTags,
  proofFilesFor,
  provableNames,
  provenTransforms,
  reconstructionReason,
  narrowCandidates,
  restoreProven,
  templateSlots,
  templatesByName,
  vouchedFiles,
} from '../utils/install-proof.util';

const SYSTEM_TLS_SECRET = 'flui-system-tls';
const MONITORING_AGENT_FLAG = 'DEPLOY_MONITORING_AGENT';

const NO_RECORD =
  'This installation has no record of the values it was built with. Reconstruct it first: POST /platform/updates/manifests/values/plan, then apply.';

/**
 * The values a master's templated manifests were rendered with.
 *
 * A master built by a current installer carries them in
 * `kube-system/flui-install-values`. One built before that carries nothing, so
 * the values are reconstructed: candidates are gathered from this database,
 * the live configuration, the IngressRoutes and the running images, and a
 * candidate is kept only when rendering a file with it reproduces the master's
 * copy exactly. What cannot be reproduced is not guessed — the files that need
 * it stay on the narrow refresh, with the reason.
 *
 * Either way a refresh proves the record again before trusting it: a file
 * someone changed on the master since is not re-rendered over.
 */
@Injectable()
export class InstallValuesService {
  private readonly logger = new Logger(InstallValuesService.name);

  constructor(
    private readonly masters: MasterAccessService,
    private readonly state: InstallStateService,
    private readonly sources: InstallSourcesService,
    private readonly master: ManifestMasterService,
  ) {}

  controlMaster(): Promise<MasterAccess> {
    return this.masters.controlMaster();
  }

  /** The master of one cluster; without an id, the control cluster's. */
  masterAccess(clusterId?: string): Promise<MasterAccess> {
    return this.masters.masterAccess(clusterId);
  }

  runningImages(
    kubeconfig: string,
    workloads: Array<{ kind: string; name: string; namespace: string }>,
  ): Promise<Map<string, string> | undefined> {
    return this.state.runningImages(kubeconfig, workloads);
  }

  /**
   * What a refresh renders templated files with: the record, proven against
   * the master's current files, with every image tag taken from what runs.
   */
  async valuesFor(
    kubeconfig: string,
    onMaster: Map<string, HeldFile>,
    targetTemplates: string[],
    secretVariables: ReadonlySet<string>,
    kind: MasterKind = 'control',
  ): Promise<ValuesContext> {
    const record = await this.state.recorded(kubeconfig);
    const flags = new Set(
      Object.entries(record?.values ?? {})
        .filter(([, v]) => v === 'true')
        .map(([k]) => k),
    );
    const none = (unavailable: string): ValuesContext => ({
      unavailable,
      unproven: {},
      transforms: record?.transforms ?? {},
      digest: '-',
      flags,
    });
    if (!record) return none(NO_RECORD);
    if (!record.values) {
      return none(
        'The installer could not tell secret values from the rest when this installation was built, so it recorded none.',
      );
    }
    if (!record.bootstrapRef) {
      return none(
        'The record does not say which release rendered these files, so it cannot be proven.',
      );
    }

    const installed = await this.sources.templatesFor(
      record.bootstrapRef,
      provableNames(onMaster),
      kind,
    );
    if (installed.length === 0) {
      return none(
        `The release this installation was built from (${record.bootstrapRef}) could not be read.`,
      );
    }
    const slots = [
      ...installed.flatMap((f) => imageTagSlots(f.template)),
      ...targetTemplates.flatMap((t) => imageTagSlots(t)),
    ];
    const running = await this.state.runningTags(kubeconfig, slots);

    const candidates: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(record.values)) {
      if (!secretVariables.has(k)) candidates[k] = [v];
    }
    for (const [k, v] of Object.entries(running)) {
      candidates[k] = [...(candidates[k] ?? []), v];
    }
    if (kind === 'workload') {
      const pushing = await this.state.runningRemoteWrite(kubeconfig);
      if (pushing) {
        candidates.REMOTE_WRITE_URL = [
          ...(candidates.REMOTE_WRITE_URL ?? []),
          pushing,
        ];
      }
    }
    const proof = proveInstallValues({
      files: proofFilesFor(
        onMaster,
        [[record.bootstrapRef, installed]],
        record,
      ),
      candidates,
      ingressTls: record.transforms.ingressTls,
      secretVariables,
    });

    const { values, unproven } = pinRunningTags(proof, slots, running);
    const transforms = provenTransforms(
      record.transforms,
      proof.ingressTlsFiles,
      onMaster,
    );
    return {
      values,
      unproven,
      transforms,
      digest: contextDigest(values, transforms, flags),
      flags,
    };
  }

  /**
   * Restores the body of every file a secret-free template reproduces. The
   * recorded values and running tags are tried first; only files still
   * unproven are tried against every candidate Flui knows, which keeps the
   * number of combinations bounded.
   */
  async readProven(
    access: MasterAccess,
    options: { refs?: string[]; images?: string[] } = {},
  ): Promise<ProvenRead> {
    const { kubeconfig, node, cluster, kind } = access;
    const held = await this.master.read(kubeconfig, node, 'all');
    const record = await this.state.recorded(kubeconfig);
    const refs = [
      ...new Set([
        ...(options.refs ?? []),
        ...(await this.sources.candidateRefs(cluster, record)),
      ]),
    ];
    const secretIndex = await this.sources.firstSecretIndex(refs);
    const secretVariables = new Set(secretIndex?.keys() ?? []);

    const perRef = await this.sources.templatesByRef(refs, held, kind);
    const templates = templatesByName(perRef);
    const mayHoldSecret = new Set(
      secretBearingFiles(
        perRef.flatMap(([, files]) => files),
        secretIndex ? secretVariables : null,
      ),
    );
    if (!record) {
      for (const name of WITHHELD_BY_HISTORY) mayHoldSecret.add(name);
    }

    const slots = templateSlots(perRef);
    const running = await this.state.runningTags(kubeconfig, slots);
    const images = [
      ...(options.images ?? []),
      ...(await this.sources.publishedImages(slots)),
    ];
    const narrow = narrowCandidates({
      recorded: record?.values ?? {},
      running,
      slots,
      images,
      secretVariables,
    });

    const files = proofFilesFor(held, perRef, record);
    const ingressTls = {
      secretName:
        record?.transforms.ingressTls?.secretName ?? SYSTEM_TLS_SECRET,
    };
    const contents = new Map<string, string>();
    const prove = (pending: typeof files, candidates: typeof narrow) =>
      restoreProven(
        proveInstallValues({
          files: pending,
          candidates,
          ingressTls,
          secretVariables,
        }),
        pending,
        ingressTls,
        contents,
      );
    const pending = prove(files, narrow);
    if (pending.length > 0) {
      const broad = await this.state.candidates(
        access,
        running,
        secretVariables,
      );
      for (const [k, list] of Object.entries(narrow)) {
        broad[k] = [...(broad[k] ?? []), ...list];
      }
      prove(pending, broad);
    }
    return { files: vouchedFiles(held, contents), mayHoldSecret, templates };
  }

  /** The reconstruction a person previews. */
  async plan(clusterId?: string): Promise<InstallValuesPlan> {
    return (await this.reconstruct(clusterId)).plan;
  }

  async apply(
    planId: string,
    clusterId?: string,
  ): Promise<InstallValuesResult> {
    const {
      plan: fresh,
      kubeconfig,
      kind,
      rendered,
      rawFiles,
      secretRefs,
    } = await this.reconstruct(clusterId);
    if (fresh.planId !== planId) {
      throw new ConflictException(
        `The reconstruction changed since the dry run (${planId} → ${fresh.planId}). Run it again and apply the plan id it prints.`,
      );
    }
    if (!fresh.willWrite) return { ...fresh, written: false };

    await this.state.writeRecord(kubeconfig, kind, {
      bootstrapRef: fresh.bootstrapRef ?? '',
      values: fresh.values,
      secretRefs,
      transforms: {
        raw: rawFiles,
        ...(fresh.ingressTlsFiles.length > 0
          ? {
              ingressTls: {
                secretName: SYSTEM_TLS_SECRET,
                files: fresh.ingressTlsFiles,
              },
            }
          : {}),
      },
      rendered,
    });
    this.logger.log(
      `Reconstructed install values: ${Object.keys(rendered).length} file(s) proven against ${fresh.bootstrapRef}`,
    );
    return { ...fresh, written: true };
  }

  private async reconstruct(clusterId?: string): Promise<{
    plan: InstallValuesPlan;
    kubeconfig: string;
    kind: MasterKind;
    rendered: Record<string, string>;
    rawFiles: string[];
    secretRefs: Record<string, string[]>;
  }> {
    const access = await this.masters.masterAccess(clusterId);
    const { kubeconfig, node, cluster, kind } = access;
    const record = await this.state.recorded(kubeconfig);
    const onMaster = await this.master.read(kubeconfig, node, 'all');
    const refs = await this.sources.candidateRefs(cluster, record);
    const secretIndex = await this.sources.secretIndex(refs);
    const secretVariables = new Set(secretIndex.keys());

    const perRef = await this.sources.templatesByRef(refs, onMaster, kind);
    const running = await this.state.runningTags(
      kubeconfig,
      templateSlots(perRef),
    );
    const candidates = await this.state.candidates(
      access,
      running,
      secretVariables,
    );

    const proofFiles = proofFilesFor(onMaster, perRef, record);
    const proof = proveInstallValues({
      files: proofFiles,
      candidates,
      ingressTls: { secretName: SYSTEM_TLS_SECRET },
      secretVariables,
    });
    const bootstrapRef = mostProvenRef(proof);
    const proven = proof.files.filter((f) => f.proven).map((f) => f.name);
    const declaredSecrets = new Set(
      perRef.flatMap(([, files]) =>
        files.flatMap((f) => placeholdersIn(f.template)),
      ),
    );
    const flags: Record<string, string> =
      kind === 'workload'
        ? {
            [MONITORING_AGENT_FLAG]: onMaster.has('vmagent.yaml')
              ? 'true'
              : 'false',
          }
        : {};

    return {
      plan: {
        clusterId: cluster.id,
        clusterType: kind,
        planId: proofDigest(
          bootstrapRef,
          [
            ...[...onMaster].map(([n, h]): [string, string] => [n, h.sha]),
            ['#cluster', cluster.id],
          ],
          proof,
        ),
        recorded: record?.source ?? null,
        bootstrapRef,
        files: proof.files.map(({ values: _values, ...rest }) => rest),
        values: { ...proof.values, ...flags },
        unproven: proof.unproven,
        ingressTlsFiles: proof.ingressTlsFiles,
        willWrite: !record && proven.length > 0,
        reason: reconstructionReason(record, proven.length),
      },
      kubeconfig,
      kind,
      rendered: Object.fromEntries(
        proven.map((n) => [n, onMaster.get(n)?.sha ?? '']),
      ),
      rawFiles: proofFiles
        .filter((f) => f.raw && proven.includes(f.name))
        .map((f) => f.name),
      secretRefs: Object.fromEntries(
        [...secretIndex].filter(([k]) => declaredSecrets.has(k)),
      ),
    };
  }
}

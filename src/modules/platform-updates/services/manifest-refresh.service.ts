import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ManifestMasterService, BACKUP_DIR } from './manifest-master.service';
import { RELEASE } from '../../../config/release.config';
import {
  Candidate,
  Judgement,
  judge,
  planDigest,
  sha256,
} from '../utils/manifest-eligibility.util';

const RAW_BASE =
  'https://raw.githubusercontent.com/flui-cloud/bootstrap-scripts';

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
  entries: RefreshEntry[];
  /** Absent when the release ships no index, which disables adding. */
  indexed: boolean;
}

export interface RefreshResult extends RefreshPlan {
  wrote: string[];
  backupPath: string;
}

/**
 * Bringing the manifests on a master into line with a release, for the files
 * where that can be done without knowing a single value.
 *
 * The narrow scope is the design. Rendering is not "template plus values": the
 * installer also runs a conditional `sed` that binds the IngressRoutes to the
 * TLS secret, several values are script constants recorded nowhere, and a file
 * with no values at all can still be destructive — `02-postgres.yaml` names its
 * image beside a volume claim.
 *
 * So this replaces only files needing no substitution, adds only files the
 * release declares, and supplies no value, ever.
 */
@Injectable()
export class ManifestRefreshService {
  private readonly logger = new Logger(ManifestRefreshService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly master: ManifestMasterService,
  ) {}

  async plan(options: {
    ref?: string;
    only?: string[];
    allowStatefulImageChange?: boolean;
  }): Promise<RefreshPlan> {
    const ref = options.ref ?? RELEASE.bootstrapRef;
    const { kubeconfig, node } = await this.masterAccess();
    const onMaster = await this.master.read(kubeconfig, node);
    const { index, files } = await this.fetchRelease(ref, [...onMaster.keys()]);

    const names = new Set<string>([...files.keys(), ...onMaster.keys()]);
    const entries: RefreshEntry[] = [];

    for (const name of [...names].sort(byName)) {
      if (options.only?.length && !options.only.includes(name)) continue;
      const release = files.get(name);
      const held = onMaster.get(name);

      if (!release) {
        entries.push({
          name,
          action: 'skip',
          reason: 'not in this release; left in place.',
          currentSha: held?.sha,
        });
        continue;
      }

      const candidate: Candidate = {
        name,
        release,
        current: held?.content,
        currentCarriesSecret: held?.carriesSecret,
        declaredByRelease: index.includes(name.replace(/\.yaml$/, '')),
      };
      // A file the master holds but whose content we deliberately never read,
      // because it carries a Secret, must still be judged — on what we do know.
      if (held && held.content === undefined && !held.carriesSecret) {
        entries.push({
          name,
          action: 'skip',
          reason: 'the reader could not return this file.',
          currentSha: held.sha,
        });
        continue;
      }

      entries.push({
        ...judge(candidate, {
          allowStatefulImageChange: options.allowStatefulImageChange,
        }),
        currentSha: held?.sha,
        releaseSha: sha256(release),
      });
    }

    return {
      ref,
      indexed: index.length > 0,
      planId: planDigest(ref, entries),
      entries,
    };
  }

  /**
   * Recomputed from scratch, then compared. A person can only apply what they
   * previewed, against the state they previewed it on — and because the digest
   * covers the release files' own contents, a `--ref` that moved between the
   * two also fails, with no need to resolve it to a commit first.
   */
  async apply(options: {
    ref?: string;
    planId: string;
    only?: string[];
    allowStatefulImageChange?: boolean;
  }): Promise<RefreshResult> {
    const fresh = await this.plan(options);
    if (fresh.planId !== options.planId) {
      // A plain Error here becomes "Internal server error" on the wire, and the
      // one sentence worth having — what changed, and what to do — is the thing
      // that gets lost. This refusal is the command's whole safety story; it has
      // to arrive.
      throw new ConflictException(
        `The plan changed since the dry run (${options.planId} → ${fresh.planId}). Run it again and apply the plan id it prints.`,
      );
    }

    const writable = fresh.entries.filter(
      (e) => e.action === 'replace' || e.action === 'add',
    );
    if (writable.length === 0) {
      return { ...fresh, wrote: [], backupPath: '' };
    }

    const { kubeconfig, node } = await this.masterAccess();
    const onMaster = await this.master.read(kubeconfig, node);
    const { files } = await this.fetchRelease(fresh.ref, [...onMaster.keys()]);
    const wrote = await this.master.write(
      kubeconfig,
      node,
      fresh.planId,
      writable.map((e) => ({
        name: e.name,
        content: files.get(e.name) as string,
        expectCurrentSha: e.currentSha,
      })),
    );
    return { ...fresh, wrote, backupPath: `${BACKUP_DIR}/${fresh.planId}` };
  }

  /**
   * What the release has to say about this master.
   *
   * With an index, the release speaks for a known set and a file it lists but
   * the master lacks can be added. Without one — an older release, or one whose
   * index has not landed yet — the release can still be asked about the files
   * the master already holds, so replacing keeps working and only adding is
   * withheld. A command that did nothing at all on an older ref would be a
   * command nobody could use to catch up, which is the entire point of it.
   */
  private async fetchRelease(
    ref: string,
    heldByMaster: string[],
  ): Promise<{ index: string[]; files: Map<string, string> }> {
    const base = `${RAW_BASE}/${encodeURIComponent(ref)}/manifests/control`;
    const indexText = await this.fetchText(`${base}/INDEX`).catch(() => null);
    const index = (indexText ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const names =
      index.length > 0
        ? index
        : heldByMaster
            .filter((n) => n.endsWith('.yaml'))
            .map((n) => n.replace(/\.yaml$/, ''));

    const files = new Map<string, string>();
    await Promise.all(
      names.map(async (name) => {
        const content = await this.fetchText(`${base}/${name}.yaml`).catch(
          () => null,
        );
        if (content !== null) files.set(`${name}.yaml`, content);
      }),
    );
    return { index, files };
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`);
    }
    return response.text();
  }

  private async controlCluster(): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
      relations: ['nodes'],
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new BadRequestException(
        'No control cluster with a kubeconfig is recorded.',
      );
    }
    return cluster;
  }

  /** The one cluster this command ever touches, and the node its files are on. */
  private async masterAccess(): Promise<{ kubeconfig: string; node: string }> {
    const cluster = await this.controlCluster();
    return {
      kubeconfig: this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
      node: this.masterOf(cluster),
    };
  }

  private masterOf(cluster: ClusterEntity): string {
    const master = (cluster.nodes ?? []).find((n) => n.nodeType === 'master');
    if (!master?.serverName) {
      throw new BadRequestException(
        'The control cluster has no master node recorded.',
      );
    }
    return master.serverName;
  }

  /**
   * What the master holds. The content of a file carrying a Secret is never
   * returned — it would travel through pod logs to get here, which is the one
   * place a live credential must not go. Its digest and the fact of the Secret
   * are enough to judge it, and the judgement is always the same: leave it.
   */
}

export type { Action, Judgement } from '../utils/manifest-eligibility.util';

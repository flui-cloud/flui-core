import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  VolumeExportService,
  liveCopyClassOf,
} from '../../providers/services/volume-export.service';
import { QuiesceMode } from './volume-copy-ledger.service';
import { hookForEngine } from './volume-copy-hooks';

/**
 * The engine the catalog declared. Read here only to find a hook — never to
 * decide whether a volume holds a database, which is answered by the disk.
 */
const DB_ENGINE_LABEL = 'flui.cloud/db-engine';
import {
  PausedWorkload,
  VolumePauseLeaseService,
} from './volume-pause-lease.service';

export interface VolumeCopyPreflightInput {
  kubeconfig: string;
  namespace: string;
  pvcName: string;
  /** Proceed even though the volume holds a database. */
  allowInconsistent?: boolean;
  /** Stop the writers first, and copy the volume at rest. */
  pause?: boolean;
}

export interface VolumeCopyPreflight {
  quiesce: QuiesceMode;
  writersAtStart: number;
  dataDirectoryDetected?: string | null;
  acknowledgedInconsistent?: boolean;
  /** The engine mechanism that made this copy safe, when one ran. */
  hook?: string;
}

/**
 * What the caller must do, kept apart from what the ledger must record.
 *
 * `facts` is spread straight into the artifact row, so nothing operational may
 * live in it: a list of paused workloads in `manifestSummary` would be state
 * pretending to be history.
 */
export interface VolumeCopyPlan {
  facts: VolumeCopyPreflight;
  paused: PausedWorkload[];
}

export const VOLUME_COPY_REFUSED = 'VOLUME_COPY_REFUSED';

/**
 * What to tell the user about this copy, or nothing.
 *
 * Replaces a caveat that was printed on every successful copy, including of an
 * uploads volume nothing was writing to. A warning that appears every time is
 * one people learn to skip, which had trained them past the single case where
 * it mattered. This speaks only when there is something true to say about the
 * copy that was actually taken.
 */
export function describeCopyRisk(
  preflight: VolumeCopyPreflight,
  writesObservedDuringCopy?: boolean,
): string | undefined {
  if (writesObservedDuringCopy) {
    return (
      'The copy tool reported files changing while it read them, so this copy ' +
      'is torn. It retried and succeeded, which is why it is recorded as ' +
      'complete — treat it as a best-effort copy, not a restore point.'
    );
  }
  if (preflight.acknowledgedInconsistent) {
    return (
      `Taken from a running ${preflight.dataDirectoryDetected} at your ` +
      'request. It may not restore cleanly; for a database prefer continuous ' +
      'backup, or copy it with the application stopped.'
    );
  }
  return undefined;
}

/**
 * The one place that decides whether a volume may be copied as it is.
 *
 * Both ad-hoc copy surfaces reach the same primitive but share no base class,
 * so before this the rule would have had to be written twice and would have
 * drifted once. It is policy, which is why it does not live in
 * `VolumeExportService` — that service owns the mechanism, including the probe
 * Job this one asks it to run.
 *
 * The rule it enforces is narrow on purpose. A copy is refused only when Flui
 * has positive evidence of the failure it is preventing: something is writing
 * to the volume *and* the volume holds a database's data directory. Everything
 * else proceeds and is recorded. In particular a volume nothing mounts is
 * copied without a probe at all — with no writer there is nothing to tear, and
 * a stopped database copies exactly as a restart would find it.
 */
@Injectable()
export class VolumeCopyPreflightService {
  private readonly logger = new Logger(VolumeCopyPreflightService.name);

  /**
   * Runs the engine's own consistency mechanism, and fails the copy if it did
   * not work. A hook that is allowed to fail quietly is worse than no hook: the
   * copy would still be taken and would still be recorded as consistent.
   */
  private async runHook(
    input: VolumeCopyPreflightInput,
    hook: { name: string; script: string },
    podName: string,
    containerName?: string,
  ): Promise<void> {
    const out = await this.k8s.execInPod(
      input.kubeconfig,
      input.namespace,
      '',
      containerName ?? '',
      ['sh', '-c', hook.script],
      podName,
    );
    if (!out.includes('FLUI_HOOK_OK')) {
      throw new ConflictException({
        code: VOLUME_COPY_REFUSED,
        dataDirectoryDetected: hook.name,
        writersAtStart: 1,
        options: ['pause', 'allowInconsistent'],
        message:
          `The ${hook.name} step did not complete, so this volume has no ` +
          'consistent image to copy. The copy was not taken.',
      });
    }
    this.logger.log(
      `[volume-copy] ${hook.name} prepared ${input.namespace}/${input.pvcName}`,
    );
  }

  constructor(
    private readonly k8s: KubernetesService,
    private readonly volumeExport: VolumeExportService,
    private readonly pauseLease: VolumePauseLeaseService,
  ) {}

  async check(input: VolumeCopyPreflightInput): Promise<VolumeCopyPlan> {
    const writers = await this.k8s.findPodsMountingPvc(
      input.kubeconfig,
      input.namespace,
      input.pvcName,
    );
    const writersAtStart = writers.length;

    // No writer, no tear, no reason to spend a pod finding out what is on the
    // disk. This is the common case — an uploads volume, or a stopped app.
    if (writersAtStart === 0) {
      // `--pause` on a volume nobody holds stopped nothing, and saying
      // `writers-stopped` would claim an action that never happened.
      return { facts: { quiesce: 'none', writersAtStart }, paused: [] };
    }

    if (input.pause) {
      const paused = await this.pauseLease.acquire(
        input.kubeconfig,
        input.namespace,
        input.pvcName,
      );
      return { facts: { quiesce: 'writers-stopped', writersAtStart }, paused };
    }

    // Between "copy it live" and "refuse": ask the engine to put a consistent
    // image on disk, and copy that. Nothing is stopped and nothing is torn.
    const holder = writers[0];
    const pod = holder
      ? await this.k8s.describePod(input.kubeconfig, input.namespace, holder)
      : null;
    const hook = hookForEngine(pod?.labels?.[DB_ENGINE_LABEL]);
    // Keyed on the declared engine alone, never on the probe. The probe exists
    // to catch databases nobody declared; the hook is for the ones Flui
    // installed and can drive. Gating it on the probe inverted the case it was
    // written for: a Redis that has taken writes but not yet reached a save
    // point has no `dump.rdb`, so the probe finds nothing, the hook is skipped,
    // and an empty volume is copied and recorded as a clean copy — while the
    // BGSAVE the hook would have run is precisely what puts that data on disk.
    if (hook && holder) {
      await this.runHook(input, hook, holder, pod?.container);
      // No probe: the engine said what it is and Flui drove its own mechanism,
      // so asking the disk the same question costs a pod and changes nothing.
      return {
        paused: [],
        facts: {
          quiesce: 'engine-hook',
          writersAtStart,
          dataDirectoryDetected: hook.engine,
          hook: hook.name,
        },
      };
    }

    const dataDirectoryDetected = await this.volumeExport.probeDataDirectory(
      input.kubeconfig,
      input.namespace,
      input.pvcName,
    );

    // Whether acknowledging the risk is even a coherent choice depends on the
    // engine. An engine that survives a power cut survives a live copy, so
    // taking one knowingly is a real decision. An engine whose store is
    // written in place produces a copy that will not open — offering a flag
    // for that is not agency, it is a trap that also counts as a successful
    // backup in every listing afterwards.
    const restorable =
      dataDirectoryDetected &&
      liveCopyClassOf(dataDirectoryDetected) !== 'not-restorable';
    const acknowledgeable = Boolean(restorable);

    if (
      dataDirectoryDetected &&
      !(acknowledgeable && input.allowInconsistent)
    ) {
      this.logger.warn(
        `[volume-copy] refused a live copy of ${input.namespace}/${input.pvcName}: ` +
          `${dataDirectoryDetected} data directory with ${writersAtStart} writer(s)`,
      );
      throw new ConflictException({
        code: VOLUME_COPY_REFUSED,
        dataDirectoryDetected,
        writersAtStart,
        options: acknowledgeable ? ['pause', 'allowInconsistent'] : ['pause'],
        message: acknowledgeable
          ? `This volume holds a ${dataDirectoryDetected} data directory and ` +
            `${writersAtStart} process(es) are writing to it. A file copy taken ` +
            'now can be torn — and the copy tool retries, so it would report ' +
            'success anyway. Either pass --pause to stop it, copy at rest and ' +
            'start it again, or --allow-inconsistent to take it as it is.'
          : `This volume holds a ${dataDirectoryDetected} store, which writes ` +
            'its files in place. A copy taken while it runs cannot be opened ' +
            'again, so Flui will not take one — there is no flag for this. ' +
            'Stop the application and copy it at rest with --pause, or leave ' +
            'this volume out of the policy if it can be rebuilt.',
      });
    }

    return {
      paused: [],
      facts: {
        quiesce: 'none',
        writersAtStart,
        // `null` from the probe means it looked and found nothing; undefined
        // means it could not run. Both are passed through unchanged, because a
        // copy nobody could inspect must not read as a copy that came back clean.
        dataDirectoryDetected,
        ...(dataDirectoryDetected && input.allowInconsistent
          ? { acknowledgedInconsistent: true }
          : {}),
      },
    };
  }
}

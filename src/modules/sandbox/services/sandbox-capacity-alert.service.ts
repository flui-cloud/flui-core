import { Injectable, Logger } from '@nestjs/common';
import { AlertEventsService } from '../../observability/services/alert-events.service';
import { AlertMailService } from '../../observability/services/alert-mail.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { DEFAULT_SANDBOX_QUOTA } from '../constants/sandbox-quota.manifest';
import {
  parseCpuMillicores,
  parseMemoryMB,
} from '../../topology/services/topology-k8s.helper';

/**
 * The one alert nothing in the cluster can raise.
 *
 * Every other rule watches something Prometheus can scrape. "The demo has no
 * room left" is a question about what would happen next, so it can only come
 * from here — and it is the one an operator most wants, because the answer to
 * it is theirs: add a node.
 *
 * The question it asks is deliberately the same one the next guest will ask by
 * deploying: could one more area's worth of work still start on this cluster?
 * It goes through `checkResourceAvailability`, the gate that refuses their
 * install, so the warning and the refusal cannot disagree — an operator told
 * "there is room" while visitors are being turned away would stop believing
 * either.
 *
 * Counting areas would no longer answer it. An area holds nothing until its
 * guest deploys something, so the old arithmetic — free resources divided by
 * what an average area holds — divides by nearly zero and reports room for
 * thousands.
 *
 * It goes through the same recorder Alertmanager's alerts go through rather
 * than mailing directly. That buys the whole of what that recorder already
 * does: an alert that is still firing on the next pass updates its row and
 * tells nobody a second time, and the recovery is announced once when the room
 * comes back. Mailing from here would have re-sent it every five minutes.
 */
@Injectable()
export class SandboxCapacityAlertService {
  private readonly logger = new Logger(SandboxCapacityAlertService.name);

  /**
   * Stable across passes on purpose: the recorder identifies an alert by it, so
   * a changing one would read as a new incident every time rather than the same
   * one continuing.
   */
  private static readonly FINGERPRINT = 'flui-sandbox-capacity';
  private static readonly ALERTNAME = 'FluiSandboxFull';

  /** When it started, kept so a continuing incident keeps its own start time. */
  private firingSince: Date | null = null;

  constructor(
    private readonly clusters: ClustersService,
    private readonly alerts: AlertEventsService,
    private readonly mail: AlertMailService,
  ) {}

  /**
   * Read the room and say so if it changed. Never throws: a demo that cannot
   * describe its own capacity must still keep serving the visitors inside it.
   */
  async check(clusterId: string | null): Promise<void> {
    if (!clusterId) return;

    try {
      // What one more *active* area is allowed to ask for. Not what an idle one
      // holds — that is nothing, which is the whole point of the model and the
      // reason counting areas stopped answering this question.
      const need = {
        cpu: parseCpuMillicores(DEFAULT_SANDBOX_QUOTA.cpuRequest),
        memory: parseMemoryMB(DEFAULT_SANDBOX_QUOTA.memoryRequest),
      };
      const room = await this.clusters.checkResourceAvailability(
        clusterId,
        need.cpu,
        need.memory,
      );
      const full = !room.canDeploy;
      if (!full && !this.firingSince) return;

      const now = new Date();
      if (full && !this.firingSince) this.firingSince = now;
      const startsAt = this.firingSince ?? now;

      const transitions = await this.alerts.record([
        {
          fingerprint: SandboxCapacityAlertService.FINGERPRINT,
          status: full ? 'firing' : 'resolved',
          startsAt,
          endsAt: full ? null : now,
          alertname: SandboxCapacityAlertService.ALERTNAME,
          severity: 'critical',
          fluiKind: 'sandbox',
          clusterId,
          labels: {},
          annotations: {
            summary: full
              ? `The demo has no room for another guest's work: ${room.available.cpu}m CPU and ${room.available.memory}Mi free`
              : `The demo has room again: ${room.available.cpu}m CPU and ${room.available.memory}Mi free`,
            description: `One more area needs about ${need.cpu}m CPU and ${need.memory}Mi. The next visitor who deploys anything will be refused by the same check. Adding a worker node is what clears it.`,
          },
        },
      ]);

      if (!full) this.firingSince = null;

      for (const { kind, event } of transitions) {
        await this.mail.deliver(kind, event);
        this.logger.log(
          kind === 'fired'
            ? `The demo has no room for another guest's work (${room.available.cpu}m CPU, ${room.available.memory}Mi free) — said once, and again when it clears`
            : `The demo has room again (${room.available.cpu}m CPU, ${room.available.memory}Mi free)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not read the demo's capacity: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

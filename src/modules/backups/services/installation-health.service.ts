import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PrometheusQueryService } from '../../observability/services/prometheus-query.service';
import { FLUI_CONTROL_NAMESPACE } from '../../infrastructure/clusters/constants';
import { describeError } from '../../shared/utils/error.util';

/** The pieces that turn a problem into an alert somebody receives. */
export const ALERT_PIPELINE_DEPLOYMENTS = ['alertmanager', 'vmalert'] as const;

export interface InstallationHealth {
  healthy: boolean;
  /** One sentence per check that failed; empty when healthy. */
  problems: string[];
}

/**
 * What the installation must be able to do for its silence to mean nothing is
 * wrong: answer from its database, read its metrics, and have the alert
 * pipeline running. Judged before every heartbeat, so a broken alert path
 * stops the beat and the outside watchdog speaks instead.
 */
@Injectable()
export class InstallationHealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: PrometheusQueryService,
  ) {}

  async check(): Promise<InstallationHealth> {
    const problems: string[] = [];

    try {
      await this.dataSource.query('SELECT 1');
    } catch (error) {
      problems.push(`The database does not answer: ${describeError(error)}`);
    }

    try {
      const query = `max by (deployment) (kube_deployment_status_replicas_available{namespace="${FLUI_CONTROL_NAMESPACE}",deployment=~"${ALERT_PIPELINE_DEPLOYMENTS.join('|')}"})`;
      const response = await this.metrics.queryInstant(query);
      if (response.status !== 'success') {
        problems.push(
          `The metrics store refused the query: ${response.error ?? 'no reason given'}`,
        );
      } else {
        const available = new Map(
          (response.data?.result ?? []).map((r) => [
            r.metric?.deployment,
            Number.parseFloat(r.value?.[1] ?? '0'),
          ]),
        );
        for (const name of ALERT_PIPELINE_DEPLOYMENTS) {
          if ((available.get(name) ?? 0) <= 0) {
            problems.push(
              `${name} has no running copy, so alerts would not be delivered`,
            );
          }
        }
      }
    } catch (error) {
      problems.push(
        `The metrics store does not answer: ${describeError(error)}`,
      );
    }

    return { healthy: problems.length === 0, problems };
  }
}
